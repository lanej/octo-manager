import { mechanicalConflicts } from "./mechanical.js";
import type { ConflictStore } from "./cases.js";
import { join } from "node:path";
import type { TrackingService } from "../tracking/service.js";
import { readObservation } from "../tracking/github.js";
import { GitHubRateLimitError } from "../github-api.js";
import { currentChecks } from "../tracking/policy.js";
import type { ObservationInput, PRObservation } from "../tracking/types.js";
import { cleanText } from "../domain.js";
import { RepairStore } from "./store.js";
import { rebaseSource } from "./github.js";
import { RebaseWorkspace } from "./git.js";
import { resolveWithWorker, type ResolveConflicts } from "./resolver.js";
import {
  RepairState,
  RepairStep,
  activeRepair,
  rebaseInput,
  type RebaseSource,
  type RepairAttempt,
  type RepairProfile,
} from "./types.js";
export interface RepairOptions {
  source?: (url: string, signal: AbortSignal) => Promise<RebaseSource>;
  workspace?: (
    directory: string,
    source: RebaseSource,
    signal: AbortSignal,
  ) => RebaseWorkspace;
  resolve?: ResolveConflicts;
  observe?: (url: string, signal: AbortSignal) => Promise<ObservationInput>;
}
export class RepairService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private nextVerify = new Map<string, number>();
  constructor(
    readonly store: RepairStore,
    private tracking: TrackingService,
    private profiles: Record<string, RepairProfile>,
    private directory: string,
    private now: () => number = Date.now,
    private options: RepairOptions = {},
    readonly conflicts?: ConflictStore,
  ) {
    for (const a of store.list())
      if (a.state === RepairState.Running)
        this.update(
          a,
          RepairState.Uncertain,
          a.step,
          "Previous repair was interrupted. Inspect the retained workspace and remote branch before a new attempt.",
        );
  }
  request(value: unknown): RepairAttempt {
    if (this.stopped) throw new Error("Repair coordinator is stopping");
    const input = rebaseInput(value);
    const existing = this.store
      .list()
      .find((a) => a.request.requestId === input.requestId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.request) !== JSON.stringify(input))
        throw new Error("Repair request ID already used with different input");
      return existing;
    }
    const profile = this.profiles[input.profile];
    if (profile === undefined) throw new Error("Invalid repair profile");
    const [, owner, repo] = new URL(input.prUrl).pathname.split("/");
    if (owner === undefined || repo === undefined)
      throw new Error("Invalid repair PR URL");
    if (profile.repository !== `${owner}/${repo}`)
      throw new Error("Repair profile does not authorize this repository");
    const pr = this.tracking.store.prs().find((p) => p.url === input.prUrl);
    if (pr === undefined || !pr.enabled)
      throw new Error("Enroll this PR before requesting repair");
    if (
      this.store.list().some((a) => a.prId === pr.id && activeRepair(a.state))
    )
      throw new Error("Another repair is active for this PR");
    return this.store.request(input, structuredClone(profile), pr.id);
  }
  start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, 250);
    this.tick();
  }
  private tick(): void {
    if (this.stopped || this.work !== undefined) return;
    const a = this.store
      .list()
      .find(
        (a) =>
          a.state === RepairState.Queued ||
          (a.state === RepairState.AwaitingChecks &&
            (this.nextVerify.get(a.id) ?? 0) <= this.now()),
      );
    if (a === undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    this.work = (
      a.state === RepairState.Queued
        ? this.run(a, controller.signal)
        : this.verify(a, controller.signal)
    )
      .catch((error: unknown) => {
        const current = this.store.get(a.id);
        const uncertain =
          current.step === RepairStep.Push || controller.signal.aborted;
        this.update(
          current,
          uncertain ? RepairState.Uncertain : RepairState.Blocked,
          current.step,
          cleanText(
            error instanceof Error ? error.message : "Repair failed",
            2000,
          ),
        );
      })
      .finally(() => {
        this.work = undefined;
        this.controller = undefined;
      });
  }
  private update(
    a: RepairAttempt,
    state: RepairState,
    step: RepairStep,
    detail: string,
    patch: Partial<RepairAttempt> = {},
  ): RepairAttempt {
    const at = this.now();
    const next = {
      ...a,
      ...patch,
      state,
      step,
      detail,
      updatedAt: at,
      history: [...a.history, { state, step, detail, at }],
    };
    this.store.save(next);
    return next;
  }
  private async run(input: RepairAttempt, signal: AbortSignal): Promise<void> {
    let a = this.update(
      input,
      RepairState.Running,
      RepairStep.Fetch,
      "Fetching the PR and current target branch",
    );
    const source = await (this.options.source ?? rebaseSource)(
      a.request.prUrl,
      signal,
    );
    if (source.repository !== a.profile.repository)
      throw new Error("Source repository changed");
    const directory = join(this.directory, "repairs", a.id);
    const workspace =
      this.options.workspace?.(directory, source, signal) ??
      new RebaseWorkspace(directory, source, signal);
    a = this.update(
      a,
      RepairState.Running,
      RepairStep.Fetch,
      "Verifying source and target revisions",
      { source, workspace: directory },
    );
    await workspace.prepare();
    a = this.update(
      a,
      RepairState.Running,
      RepairStep.Rebase,
      "Rebasing with Git; no agent needed unless conflicts remain",
    );
    let paths = await workspace.rebase();
    let rounds = 0;
    while (paths.length > 0) {
      if (++rounds > 32)
        throw new Error("Rebase exceeded 32 conflict stops; inspect manually");
      if (this.conflicts === undefined)
        throw new Error("Conflict evidence store is unavailable");
      a = this.update(
        a,
        RepairState.Running,
        RepairStep.Resolve,
        "Trying deterministic conflict recipes before an agent",
        { conflictedPaths: paths },
      );
      const mechanical = await mechanicalConflicts(
        workspace,
        paths,
        this.conflicts,
        a.id,
        rounds,
      );
      a = this.update(
        a,
        RepairState.Running,
        RepairStep.Resolve,
        `Mechanically resolved ${String(mechanical.applied)} file(s); ${String(mechanical.remaining.length)} remain`,
        { mechanicalRepairs: a.mechanicalRepairs + mechanical.applied },
      );
      if (mechanical.remaining.length > 0) {
        a = this.update(
          a,
          RepairState.Running,
          RepairStep.Resolve,
          `Repair session resolving ${String(mechanical.remaining.length)} remaining file(s)`,
          { conflictedPaths: mechanical.remaining, usedAgent: true },
        );
        await (this.options.resolve ?? resolveWithWorker)(
          workspace,
          mechanical.remaining,
          a.profile,
          signal,
        );
        for (const path of mechanical.remaining) {
          const id = mechanical.cases.get(path);
          if (id !== undefined)
            this.conflicts.agentResult(id, await workspace.read(path));
        }
      }
      await workspace.stage(paths);
      a = this.update(
        a,
        RepairState.Running,
        RepairStep.Rebase,
        "Continuing the rebase after conflict resolution",
      );
      paths = await workspace.rebase(true);
    }
    a = this.update(
      a,
      RepairState.Running,
      RepairStep.Checks,
      "Running the configured checks",
      { conflictedPaths: [] },
    );
    const head = await workspace.validate(
      a.profile.checks,
      a.profile.timeoutMs,
    );
    const fresh = await (this.options.source ?? rebaseSource)(
      a.request.prUrl,
      signal,
    );
    if (JSON.stringify(fresh) !== JSON.stringify(source))
      throw new Error(
        "PR or target branch changed during repair; nothing pushed",
      );
    a = this.update(
      a,
      RepairState.Running,
      RepairStep.Push,
      "Pushing the rebased branch with an exact lease",
      { resultHead: head },
    );
    await workspace.push(head);
    a = this.update(
      a,
      RepairState.AwaitingChecks,
      RepairStep.Verify,
      "Rebased branch pushed; waiting for GitHub verification",
    );
    await this.verify(a, signal);
  }
  private async verify(a: RepairAttempt, signal: AbortSignal): Promise<void> {
    this.nextVerify.set(a.id, this.now() + 15000);
    let o: ObservationInput;
    try {
      o = await (this.options.observe ?? readObservation)(
        a.request.prUrl,
        signal,
      );
    } catch (error) {
      if (error instanceof GitHubRateLimitError)
        this.nextVerify.set(
          a.id,
          Math.max(this.now() + 15000, error.retryAtMs),
        );
      this.update(
        a,
        RepairState.AwaitingChecks,
        RepairStep.Verify,
        signal.aborted
          ? "Verification paused; it will resume when the coordinator restarts"
          : `GitHub verification unavailable; retrying: ${cleanText(error instanceof Error ? error.message : "Read failed", 1500)}`,
      );
      return;
    }

    if (o.headSha !== a.resultHead) {
      this.update(
        a,
        RepairState.Blocked,
        RepairStep.Verify,
        "PR head changed after repair; inspect the newer branch",
      );
      return;
    }
    if (
      a.source === undefined ||
      o.targetBase === undefined ||
      o.lifecycle !== "open" ||
      o.targetBase.sha !== a.source.targetSha ||
      o.targetBase.ref !== a.source.targetRef
    ) {
      this.update(
        a,
        RepairState.Blocked,
        RepairStep.Verify,
        "PR lifecycle or target changed after repair; inspect the new state",
      );
      return;
    }
    this.tracking.store.observe(a.prId, o, this.tracking.config);
    if (o.mergeability === "conflicting") {
      this.update(
        a,
        RepairState.Failed,
        RepairStep.Verify,
        "GitHub still reports conflicts",
      );
      return;
    }
    const checks = currentChecks({
      ...o,
      id: 0,
      prId: a.prId,
    } satisfies PRObservation);
    if (
      checks.some(
        (c) =>
          (c.status === "completed" &&
            !["success", "neutral", "skipped"].includes(c.conclusion)) ||
          c.status === "failure" ||
          c.status === "error",
      )
    ) {
      this.update(
        a,
        RepairState.Failed,
        RepairStep.Verify,
        "Rebased branch has failing GitHub checks",
      );
      return;
    }
    if (
      a.profile.githubChecks.some(
        (name) =>
          !checks.some(
            (check) =>
              check.name === name &&
              ["completed", "success"].includes(check.status) &&
              ["success", "neutral", "skipped"].includes(check.conclusion),
          ),
      )
    )
      return;
    if (
      o.mergeability !== "mergeable" ||
      o.checks.state !== "complete" ||
      checks.some(
        (c) => !["success", "neutral", "skipped"].includes(c.conclusion),
      )
    )
      return;
    this.update(
      a,
      RepairState.Succeeded,
      RepairStep.Verify,
      "Rebased branch verified on GitHub; configured local checks passed",
    );
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.controller?.abort();
    await this.work;
  }
}
