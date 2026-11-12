import { Check } from "typebox/value";
import { shortId } from "../tracking/identifiers.js";
import {
  SubmissionState as State,
  SubmissionInputSchema,
  PolicyAnalysisSchema,
  ChangeAnalysisSchema,
  WriterSchema,
  parse,
  policyBlockers,
  anchorPolicy,
  publicationBlockers,
  renderTemplate,
  stockProfiles,
  type Submission,
  type Role,
  type StageResult,
  type RepositorySnapshot,
  type RepositoryPolicy,
} from "./contracts.js";
import type { TSchema } from "typebox";
import { SubmissionStore } from "./store.js";
import {
  GitHubSubmissions,
  type SubmissionGitHub,
  type PublishedPR,
} from "./github.js";
import { runStage, type RunStage } from "./worker.js";
import { stageInstructions } from "./prompts.js";
import type { TrackingService } from "../tracking/service.js";
const terminal = new Set([
  State.Succeeded,
  State.NeedsInput,
  State.Failed,
  State.Uncertain,
  State.Cancelled,
]);
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
export interface SubmissionOptions {
  github?: SubmissionGitHub;
  run?: RunStage;
  instructions?: typeof stageInstructions;
  models?: Partial<Record<Role, string>>;
}
export class SubmissionService {
  private active:
    | { id: string; abort: AbortController; work: Promise<void> }
    | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private github: SubmissionGitHub;
  constructor(
    readonly store: SubmissionStore,
    private tracking: TrackingService,
    private options: SubmissionOptions = {},
  ) {
    this.github = options.github ?? new GitHubSubmissions();
    for (const value of store.list())
      if (!terminal.has(value.state) && value.state !== State.Queued)
        store.save({
          ...value,
          state:
            value.state === State.Publishing || value.state === State.Enrolling
              ? State.Uncertain
              : State.Failed,
          detail:
            "Coordinator interrupted; retry explicitly after previous workers exit",
        });
  }
  start(): void {
    for (const value of this.store.list())
      if (
        terminal.has(value.state) &&
        value.state !== State.Cancelled &&
        value.notificationRevision === 0
      )
        this.notice(value.id);
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
    this.tick();
  }
  submit(raw: unknown): Submission {
    if (this.stopped) throw new Error("Coordinator is stopping");
    if (Buffer.byteLength(JSON.stringify(raw)) > 12000)
      throw new Error("Submission input exceeds 12000 bytes");
    const request = parse(SubmissionInputSchema, raw);
    this.tracking.registerAgent(request.owner);
    const value = this.store.request({
      ...request,
      repository: request.repository.toLowerCase(),
    });
    queueMicrotask(() => {
      this.tick();
    });
    return value;
  }
  retry(id: string): Submission {
    const value = this.store.get(id);
    if (
      this.stopped ||
      this.active?.id === value.id ||
      value.workerPids.some(alive)
    )
      throw new Error("Wait for the previous workers to exit");
    if (![State.Failed, State.Uncertain].includes(value.state))
      throw new Error(
        "Only failed or uncertain submissions can be retried; use a new request for changed facts",
      );
    this.store.invalidateNotices(value.id);
    const next = this.store.save({
      ...value,
      state: State.Queued,
      detail: "Retry queued",
      workerPids: [],
      notificationRevision: 0,
    });
    queueMicrotask(() => {
      this.tick();
    });
    return next;
  }
  cancel(id: string): Submission {
    const value = this.store.get(id);
    if (terminal.has(value.state)) return value;
    if (
      value.state === State.Publishing ||
      value.state === State.Enrolling ||
      value.brief !== undefined
    )
      throw new Error(
        "Publication may have happened; reconcile with retry instead of cancellation",
      );
    if (this.active?.id === value.id) this.active.abort.abort();
    this.store.invalidateNotices(value.id);
    return this.store.save({
      ...value,
      state: State.Cancelled,
      detail: "Submission cancelled",
    });
  }
  private tick(): void {
    if (
      this.stopped ||
      this.active !== undefined ||
      this.store.list().some((value) => value.workerPids.some(alive))
    )
      return;
    const value = this.store
      .list()
      .find((value) => value.state === State.Queued);
    if (value === undefined) return;
    const abort = new AbortController();
    const active = { id: value.id, abort, work: Promise.resolve() };
    this.active = active;
    active.work = this.execute(value.id, abort.signal).finally(() => {
      this.active = undefined;
      if (!this.stopped)
        queueMicrotask(() => {
          this.tick();
        });
    });
  }
  private update(id: string, patch: Partial<Submission>): Submission {
    return this.store.save({ ...this.store.get(id), ...patch });
  }
  private async stage(
    id: string,
    role: Role,
    input: unknown,
    schema: TSchema,
    signal: AbortSignal,
  ): Promise<StageResult> {
    const existing = this.store
      .get(id)
      .stages.findLast(
        (stage) => stage.role === role && Check(schema, stage.result),
      );
    if (existing !== undefined) return existing;
    const instructions = await (this.options.instructions ?? stageInstructions)(
      role,
    );
    const result = await (this.options.run ?? runStage)(
      role,
      input,
      schema,
      instructions,
      this.options.models?.[role] ?? "gpt-6.1-terra",
      signal,
      (pid, active) => {
        const value = this.store.get(id);
        this.update(id, {
          workerPids: active
            ? [...value.workerPids, pid]
            : value.workerPids.filter((item) => item !== pid),
        });
      },
    );
    const value = this.store.get(id);
    this.update(id, { stages: [...value.stages, result] });
    parse(schema, result.result);
    return result;
  }
  private async policy(
    id: string,
    snapshot: RepositorySnapshot,
    signal: AbortSignal,
  ): Promise<RepositoryPolicy> {
    const pinned = this.store.get(id).policyVersion;
    const existing =
      pinned === undefined
        ? this.store.get(id).request.mode === "policy"
          ? undefined
          : this.store.cached(snapshot)
        : this.store.policy(snapshot.repository, pinned);
    if (existing !== undefined) return existing;
    if (snapshot.sources.length === 0) {
      const policy = this.store.savePolicy(snapshot, {
        requirements: [],
        template: "",
        blockers: [],
      });
      this.update(id, {
        policyVersion: policy.version,
        policyDigest: policy.sourceDigest,
      });
      return policy;
    }
    const stage = await this.stage(
      id,
      "policy",
      {
        sources: snapshot.sources.map((source) => ({
          path: source.path,
          sha: source.sha,
          numberedLines: source.text
            .split("\n")
            .map((text, index) => `${String(index + 1)}: ${text}`),
        })),
      },
      PolicyAnalysisSchema,
      signal,
    );
    const { analysis, corrections } = anchorPolicy(
      parse(PolicyAnalysisSchema, stage.result),
      snapshot.sources,
    );
    const blockers = policyBlockers(analysis, snapshot.sources);
    if (blockers.length > 0) throw new InputNeeded(blockers.join("; "));
    const policy = this.store.savePolicy(snapshot, analysis, corrections);
    this.update(id, {
      policyVersion: policy.version,
      policyDigest: policy.sourceDigest,
    });
    return policy;
  }
  private async execute(id: string, signal: AbortSignal): Promise<void> {
    try {
      let value = this.store.get(id);
      const marker = `<!-- octo-submission:${id} -->`;
      if (value.prUrl !== undefined) {
        this.enroll(id, value.prUrl);
        return;
      }
      if (value.brief !== undefined) {
        const recovered = await this.github.find(value.request, marker, signal);
        if (recovered !== undefined) {
          signal.throwIfAborted();
          this.verifyPublished(value, recovered, marker);
          this.enroll(id, recovered.url);
          return;
        }
      }
      this.update(id, {
        state: State.Analyzing,
        detail: "Analyzing contribution policy and change",
      });
      const snapshot =
        value.snapshot ?? (await this.github.snapshot(value.request, signal));
      this.update(id, { snapshot });
      if (value.request.mode === "policy") {
        const policy = await this.policy(id, snapshot, signal);
        signal.throwIfAborted();
        this.update(id, {
          state: State.Succeeded,
          policyVersion: policy.version,
          policyDigest: policy.sourceDigest,
          detail: "Contribution policy refreshed",
        });
        this.notice(id);
        return;
      }
      const stages = await Promise.allSettled([
        this.policy(id, snapshot, signal),
        this.stage(
          id,
          "change",
          { request: value.request, snapshot },
          ChangeAnalysisSchema,
          signal,
        ),
      ]);
      const policyResult = stages[0],
        changeResult = stages[1];
      if (policyResult.status === "rejected")
        throw policyResult.reason instanceof Error
          ? policyResult.reason
          : new Error("Policy analysis failed");
      if (changeResult.status === "rejected")
        throw changeResult.reason instanceof Error
          ? changeResult.reason
          : new Error("Change analysis failed");
      const policy = policyResult.value,
        changeStage = changeResult.value;
      signal.throwIfAborted();
      const change = parse(ChangeAnalysisSchema, changeStage.result);
      this.update(id, {
        state: State.Writing,
        detail: "Dedicated PR writer drafting",
        policyVersion: policy.version,
        policyDigest: policy.sourceDigest,
      });
      const draftStage = await this.stage(
        id,
        "writer",
        {
          request: value.request,
          snapshot,
          policy,
          change,
          profile: (policy.complexityProfiles ?? stockProfiles)[change.tier],
          template: renderTemplate(policy, change.tier),
        },
        WriterSchema,
        signal,
      );
      const brief = {
        schemaVersion: 1 as const,
        request: value.request,
        baseSha: snapshot.baseSha,
        policyVersion: policy.version,
        change,
        draft: parse(WriterSchema, draftStage.result),
      };
      this.update(id, { brief });
      const blockers = publicationBlockers(brief, policy, snapshot.files);
      if (blockers.length > 0) throw new InputNeeded(blockers.join("; "));
      await this.github.verify(value.request, snapshot.baseSha, signal);
      const recovered = await this.github.find(value.request, marker, signal);
      signal.throwIfAborted();
      this.update(id, {
        state: State.Publishing,
        detail: "Publishing approved structured draft",
      });
      value = this.store.get(id);
      const published =
        recovered ??
        (await this.github.publish(value.request, brief.draft, marker, signal));
      this.verifyPublished(value, published, marker);
      this.enroll(id, published.url);
    } catch (error) {
      // WHY: Wait for both parallel stages before releasing the slot or closing durable storage.
      const value = this.store.get(id);
      if (value.state === State.Cancelled) return;
      const state =
        value.state === State.Publishing || value.state === State.Enrolling
          ? State.Uncertain
          : error instanceof InputNeeded
            ? State.NeedsInput
            : State.Failed;
      const detail = (
        error instanceof Error ? error.message : "Submission failed"
      ).slice(0, 2000);
      this.update(id, { state, detail });
      this.notice(id);
    }
  }
  private verifyPublished(
    value: Submission,
    pr: PublishedPR,
    marker: string,
  ): void {
    if (
      pr.headSha !== value.request.headSha ||
      !pr.body.includes(marker) ||
      pr.state !== "open" ||
      !pr.url
        .toLowerCase()
        .startsWith(
          `https://github.com/${value.request.repository.toLowerCase()}/pull/`,
        )
    )
      throw new Error(
        "Published PR identity changed; inspect before enrollment",
      );
  }
  private enroll(id: string, url: string): void {
    const value = this.update(id, {
      prUrl: url,
      state: State.Enrolling,
      detail: "Enrolling PR and caller ownership",
    });
    const pr = this.tracking.track(url, value.request.owner);
    this.update(id, {
      prId: pr.id,
      state: State.Succeeded,
      detail: "PR published and tracking active",
    });
    this.notice(id);
  }
  private notice(id: string): void {
    const value = this.store.get(id);
    if (value.notificationRevision > 0) return;
    const owner = this.tracking.store.registerAgent(value.request.owner);
    this.store.notify(
      value,
      owner.id,
      value.state === State.Succeeded && value.request.mode === "policy"
        ? `Contribution policy v${String(value.policyVersion)} stored for ${value.request.repository}.`
        : value.state === State.Succeeded
          ? `[PR #${value.prUrl?.split("/").at(-1) ?? ""}](${value.prUrl ?? ""}) · Published; tracking active.`
          : `PR submission ${value.state}: ${value.detail.slice(0, 400)}\nNext: octo-manager submission ${shortId(
              id,
              this.store.list().map((item) => item.id),
            )}`,
    );
    this.update(id, { notificationRevision: 1 });
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.active?.abort.abort();
    await this.active?.work;
  }
}
class InputNeeded extends Error {}
