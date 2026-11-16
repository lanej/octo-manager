import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpathSync as realpath } from "node:fs";
import {
  IssueStage,
  Waiting,
  Role,
  AttemptState,
  terminal,
  roleFor,
  result,
  type IssueRecord,
  type IssuePolicy,
  type Assignment,
  type StageResult,
} from "./contracts.js";
import type {
  IssueTracker,
  AgentDispatcher,
  IssueWorkspace,
  IssueCodeHost,
} from "./ports.js";
import { IssueStore } from "./store.js";
import { applyResult, canImplement } from "./decisions.js";
import { assignmentPrompt } from "./prompts.js";
export interface IssueOptions {
  trackers: IssueTracker[];
  dispatchers: AgentDispatcher[];
  workspace: IssueWorkspace;
  codeHost: IssueCodeHost;
  policy: (root: string) => IssuePolicy;
}
export class IssueService {
  private work: Promise<void> | undefined;
  private effectChecks = new Map<string, number>();
  private abort = new AbortController();
  constructor(
    readonly store: IssueStore,
    private options: IssueOptions,
    private now: () => number = Date.now,
  ) {
    store.recover();
  }
  private authorize(expected: IssueRecord): IssueRecord {
    const current = this.store.get(expected.id);
    if (
      current.epoch !== expected.epoch ||
      current.stage !== expected.stage ||
      current.brief?.version !== expected.brief?.version ||
      current.assignmentId !== expected.assignmentId ||
      current.approvedVersion !== expected.approvedVersion ||
      current.publicationVersion !== expected.publicationVersion ||
      current.waiting === Waiting.Paused ||
      current.stage === IssueStage.Cancelled ||
      this.options.policy(current.root).hash !== current.policyHash
    )
      throw new Error("Issue authority changed during operation");
    return current;
  }
  private tracker(issue: IssueRecord): IssueTracker {
    const tracker = this.options.trackers.find(
      (item) => item.provider === issue.ref.provider,
    );
    if (tracker == null) throw new Error("Issue tracker not configured");
    return tracker;
  }
  private dispatcher(assignment: Assignment): AgentDispatcher {
    const dispatcher = this.options.dispatchers.find(
      (item) => item.harness === assignment.profile.harness,
    );
    if (dispatcher == null) throw new Error("Agent dispatcher not configured");
    return dispatcher;
  }
  enroll(
    provider: string,
    url: string,
    root: string,
    ownerId: string,
    requestId: string,
  ): IssueRecord {
    return this.store.atomic(() =>
      this.enrollOnce(provider, url, root, ownerId, requestId),
    );
  }
  private enrollOnce(
    provider: string,
    url: string,
    root: string,
    ownerId: string,
    requestId: string,
  ): IssueRecord {
    const input = JSON.stringify([provider, url, root, ownerId]);
    const prior = this.store.request(requestId, input);
    if (prior != null) return this.store.get(prior);
    const tracker = this.options.trackers.find(
      (item) => item.provider === provider,
    );
    if (tracker == null) throw new Error("Unsupported issue tracker");
    const ref = tracker.identify(url);
    const existing = this.store
      .list()
      .find(
        (issue) =>
          issue.ref.provider === ref.provider &&
          issue.ref.project === ref.project &&
          issue.ref.externalId === ref.externalId,
      );
    if (existing != null) {
      this.store.remember(requestId, input, existing.id);
      return existing;
    }
    if (ownerId.length === 0)
      throw new Error("Calling agent owner is required");
    const verifiedRoot = realpath(resolve(root));
    tracker.verifyRepository(verifiedRoot, ref);
    const policy = this.options.policy(verifiedRoot);
    const issue: IssueRecord = {
      id: randomUUID(),
      ref,
      root: verifiedRoot,
      ownerId,
      title: "",
      body: "",
      stage: IssueStage.Investigation,
      waiting: Waiting.None,
      detail: "Enrolled for investigation",
      epoch: 0,
      brief: undefined,
      approvedVersion: 0,
      publicationVersion: 0,
      policyHash: policy.hash,
      externalClosed: false,
      comments: [],
      reviewedComments: [],
      pendingComments: [],
      clarificationRound: 0,
      clarificationDueAt: undefined,
      timeoutPlanned: false,
      prUrl: "",
      prHead: "",
      verifiedHead: "",
      assignmentId: "",
      workspace: "",
      createdAt: this.now(),
      updatedAt: this.now(),
      nextAt: 0,
      pollIntervalMs: 60000,
    };
    this.store.save(issue, "enrolled", issue.detail);
    this.store.remember(requestId, input, issue.id);
    return issue;
  }
  mergeAllowed(url: string): boolean {
    return this.store
      .list()
      .filter((issue) => issue.prUrl === url)
      .every(
        (issue) =>
          issue.stage === IssueStage.InReview &&
          issue.waiting === Waiting.None &&
          issue.pendingComments.length === 0 &&
          issue.brief !== undefined &&
          !issue.brief.blockingQuestions,
      );
  }
  command(
    id: string,
    operation: string,
    text: string,
    version: number,
    requestId: string,
  ): IssueRecord {
    return this.store.atomic(() =>
      this.commandOnce(id, operation, text, version, requestId),
    );
  }
  private commandOnce(
    id: string,
    operation: string,
    text: string,
    version: number,
    requestId: string,
  ): IssueRecord {
    const input = JSON.stringify([id, operation, text, version]);
    const prior = this.store.request(requestId, input);
    if (prior != null) return this.store.get(prior);
    let issue = this.store.get(id);
    if (terminal(issue.stage) && operation !== "resume")
      throw new Error("Issue is terminal");
    switch (operation) {
      case "approve":
        if (issue.brief == null || version !== issue.brief.version)
          throw new Error("Approval requires the current brief version");
        if (issue.brief.blockingQuestions)
          throw new Error("Blocking questions remain");
        issue = {
          ...issue,
          approvedVersion: version,
          stage: IssueStage.Ready,
          waiting: Waiting.None,
          detail: "Implementation approved for brief",
        };
        break;
      case "approve-publication":
        if (issue.brief == null || version !== issue.brief.version)
          throw new Error(
            "Publication approval requires the current brief version",
          );
        issue = {
          ...issue,
          publicationVersion: version,
          waiting: Waiting.None,
          detail: "Publication approved",
        };
        break;
      case "approve-follow-up": {
        const assignment = this.store
          .assignments(issue.id)
          .find(
            (item) =>
              item.id === text && item.result?.disposition === "follow_up",
          );
        if (
          assignment === undefined ||
          assignment.result === undefined ||
          assignment.epoch !== issue.epoch
        )
          throw new Error("Current follow-up assignment ID required in --text");
        this.queueEffect(
          issue,
          `followup:${assignment.id}`,
          "follow_up",
          assignment.result.followUpBody ?? "",
          assignment.result.followUpTitle ?? "",
        );
        issue = {
          ...issue,
          waiting: Waiting.None,
          detail: "Linked follow-up approved",
        };
        break;
      }
      case "answer":
        if (text.trim().length === 0)
          throw new Error("Clarification answer required");
        issue = {
          ...issue,
          epoch: issue.epoch + 1,
          pendingComments: [
            ...issue.pendingComments,
            {
              id: `local:${requestId}`,
              revision: String(this.now()),
              author: "operator",
              body: text,
              url: issue.ref.url,
            },
          ],
          waiting: Waiting.None,
          detail: "Answer awaiting investigation",
        };
        this.queueEffect(
          issue,
          `answer:${requestId}`,
          "post",
          `Clarification answer\n\n${text}`,
        );
        break;
      case "pause":
        issue = {
          ...issue,
          waiting: Waiting.Paused,
          epoch: issue.epoch + 1,
          detail: "Paused by operator",
        };
        break;
      case "resume":
        if (terminal(issue.stage))
          throw new Error(
            "Re-enrollment of terminal issues requires a new lifecycle, not resume",
          );
        issue = {
          ...issue,
          waiting: Waiting.None,
          detail: "Resumed; current evidence required",
          nextAt: 0,
        };
        break;
      case "cancel":
        issue = {
          ...issue,
          stage: IssueStage.Cancelled,
          waiting: Waiting.None,
          epoch: issue.epoch + 1,
          detail: "Cancelled by operator",
        };
        break;
      case "refresh":
        issue = { ...issue, nextAt: 0 };
        break;
      default:
        throw new Error("Unsupported issue operation");
    }
    this.store.save(issue, operation, issue.detail);
    this.store.remember(requestId, input, issue.id);
    return issue;
  }
  tick(): Promise<void> {
    if (this.work != null) return this.work;
    if (this.abort.signal.aborted) return Promise.resolve();
    this.work = this.run().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.work;
  }
  private queueEffect(
    issue: IssueRecord,
    key: string,
    kind: string,
    body: string,
    title = "",
  ): void {
    this.store.effect({
      id: `${issue.id}:${key}`,
      issueId: issue.id,
      kind,
      body,
      title,
      state: "intended",
      url: "",
    });
  }
  private async effects(): Promise<void> {
    const pending = this.store.effects();
    const ids = new Set(pending.map((effect) => effect.id));
    for (const id of this.effectChecks.keys())
      if (!ids.has(id)) this.effectChecks.delete(id);
    for (const effect of pending) {
      if ((this.effectChecks.get(effect.id) ?? 0) > this.now()) continue;
      this.effectChecks.set(effect.id, this.now() + 60000);
      const issue = this.store.get(effect.issueId);
      const tracker = this.tracker(issue);
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(30000),
      ]);
      try {
        const briefVersion = /:brief:(\d+)$/u.exec(effect.id)?.[1];
        if (
          effect.kind === "post" &&
          briefVersion !== undefined &&
          Number(briefVersion) < (issue.brief?.version ?? 0)
        ) {
          this.store.effect({ ...effect, state: "superseded" });
          continue;
        }
        if (effect.kind === "commit") {
          const payload: unknown = JSON.parse(effect.body);
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("version" in payload) ||
            payload.version !== issue.brief?.version ||
            issue.pendingComments.length > 0 ||
            issue.stage !== IssueStage.Testing
          ) {
            this.store.effect({ ...effect, state: "completed" });
            continue;
          }
          const policy = this.options.policy(issue.root);
          if (
            !policy.implement &&
            issue.approvedVersion !== issue.brief?.version
          )
            continue;
          this.store.effect({ ...effect, state: "uncertain" });
          const head = await this.options.codeHost.commit(issue, signal, () => {
            this.authorize(issue);
          });
          let current: IssueRecord;
          try {
            current = this.authorize(issue);
          } catch {
            this.store.effect({ ...effect, state: "completed", url: head });
            continue;
          }
          this.store.save(
            {
              ...current,
              waiting: Waiting.None,
              detail: `Local commit prepared for testing: ${head}`,
            },
            "committed",
            head,
          );
          this.store.effect({ ...effect, state: "completed", url: head });
          continue;
        }
        if (effect.kind === "publish") {
          const policy = this.options.policy(issue.root);
          const payload = JSON.parse(effect.body) as unknown;
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("version" in payload) ||
            !("result" in payload)
          )
            throw new Error("Invalid publication intent");
          if (
            payload.version !== issue.brief?.version ||
            issue.pendingComments.length > 0 ||
            issue.stage !== IssueStage.Testing
          ) {
            this.store.effect({ ...effect, state: "completed" });
            continue;
          }
          if (
            !policy.publish &&
            issue.publicationVersion !== issue.brief?.version
          )
            continue;
          this.store.effect({ ...effect, state: "uncertain" });
          const published = await this.options.codeHost.publish(
            effect.id,
            issue,
            result(payload.result),
            signal,
            () => {
              this.authorize(issue);
            },
          );
          let current: IssueRecord;
          try {
            current = this.authorize(issue);
          } catch {
            this.store.effect({
              ...effect,
              state: "completed",
              url: published.url,
            });
            continue;
          }
          this.options.codeHost.enroll(
            published.url,
            issue.ownerId,
            issue.workspace,
          );
          this.store.save(
            {
              ...current,
              prUrl: published.url,
              prHead: published.head,
              stage: IssueStage.InReview,
              waiting: Waiting.None,
              detail: "PR published; review and checks tracked",
            },
            "published",
            published.url,
          );
          this.store.effect({
            ...effect,
            state: "completed",
            url: published.url,
          });
          continue;
        }
        if (effect.kind === "close") {
          if (issue.stage !== IssueStage.Done) continue;
          const observed = await tracker.observe(issue.ref, signal);
          this.authorize(issue);
          const ownPosts = this.store.ownPosts(issue.id);
          const fresh = observed.comments.filter(
            (comment) =>
              !ownPosts.some(
                (post) =>
                  post.url === comment.url && post.body === comment.body,
              ) &&
              !issue.reviewedComments.includes(
                `${comment.id}:${comment.revision}`,
              ),
          );
          if (
            !observed.complete ||
            fresh.length > 0 ||
            observed.body !== issue.body
          ) {
            this.store.save(
              {
                ...issue,
                stage: IssueStage.Investigation,
                waiting: Waiting.None,
                epoch: issue.epoch + 1,
                pendingComments: fresh,
                detail:
                  "New input before closure; acceptance must be reassessed",
                nextAt: 0,
              },
              "closure_deferred",
              "Tracker input changed",
            );
            this.store.effect({ ...effect, state: "completed" });
            continue;
          }
          if (!observed.closed) {
            this.store.effect({ ...effect, state: "uncertain" });
            await tracker.close(issue.ref, signal, () => {
              this.authorize(issue);
            });
          }
          const confirmed = await tracker.observe(issue.ref, signal);
          if (!confirmed.closed) throw new Error("Issue closure unconfirmed");
          this.store.effect({ ...effect, state: "completed" });
          continue;
        }
        if (terminal(issue.stage) && issue.stage !== IssueStage.Done) {
          this.store.effect({ ...effect, state: "completed" });
          continue;
        }
        const url =
          effect.kind === "follow_up"
            ? await tracker.findFollowUp(issue.ref, effect.id, signal)
            : await tracker.findPost(issue.ref, effect.id, signal);
        if (url != null) {
          this.store.effect({ ...effect, state: "completed", url });
          continue;
        }
        if (effect.state === "uncertain") continue;
        // rationale: An interrupted write remains uncertain; absence from a later read does not prove GitHub rejected it.
        this.authorize(issue);
        this.store.effect({ ...effect, state: "uncertain" });
        const created =
          effect.kind === "follow_up"
            ? await tracker.createFollowUp(
                issue.ref,
                effect.id,
                effect.title,
                effect.body,
                signal,
                () => {
                  this.authorize(issue);
                },
              )
            : await tracker.post(
                issue.ref,
                effect.id,
                effect.body,
                signal,
                () => {
                  this.authorize(issue);
                },
              );
        this.store.effect({ ...effect, state: "completed", url: created });
      } catch (error) {
        this.store.save(
          {
            ...this.store.get(issue.id),
            detail:
              error instanceof Error
                ? error.message
                : "Tracker effect unavailable",
          },
          "effect_pending",
          effect.id,
        );
      }
    }
  }
  private async refresh(issue: IssueRecord): Promise<IssueRecord> {
    const observed = await this.tracker(issue).observe(
      issue.ref,
      AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
    );
    issue = this.store.get(issue.id);
    if (terminal(issue.stage)) return issue;
    if (!observed.complete)
      throw new Error(
        "Incomplete issue comment evidence; retaining previous lifecycle",
      );
    const ownPosts = this.store.ownPosts(issue.id);
    const comments = observed.comments.filter(
      (comment) =>
        !ownPosts.some(
          (post) => post.url === comment.url && post.body === comment.body,
        ),
    );
    const changed = comments.filter(
      (comment) =>
        !issue.reviewedComments.includes(`${comment.id}:${comment.revision}`),
    );
    // The empty title identifies enrollment before its first observation; an empty body is valid observed input.
    const bodyChanged = issue.title !== "" && issue.body !== observed.body;
    const pending = [...issue.pendingComments];
    for (const item of changed)
      if (
        !pending.some(
          (prior) => prior.id === item.id && prior.revision === item.revision,
        )
      )
        pending.push(item);
    if (bodyChanged)
      pending.push({
        id: "issue-body",
        revision: observed.revision,
        author: "issue author",
        body: observed.body,
        url: issue.ref.url,
      });
    const hasNew = pending.length !== issue.pendingComments.length;
    const interval =
      hasNew ||
      issue.stage === IssueStage.InReview ||
      issue.stage === IssueStage.Verification
        ? 60000
        : Math.min(issue.pollIntervalMs * 2, 900000);
    const next = {
      ...issue,
      title: observed.title,
      body: observed.body,
      comments,
      externalClosed: observed.closed,
      pendingComments: pending,
      epoch: issue.epoch + (hasNew ? 1 : 0),
      waiting:
        observed.closed || issue.waiting === Waiting.Paused
          ? Waiting.Paused
          : hasNew
            ? Waiting.None
            : issue.waiting,
      detail: observed.closed
        ? "Issue closed externally; dispatch paused"
        : issue.detail,
      nextAt: this.now() + interval,
      pollIntervalMs: interval,
    };
    this.store.save(
      next,
      "observed",
      hasNew
        ? "New issue input requires assessment"
        : "Tracker observation retained",
    );
    return next;
  }
  private async run(): Promise<void> {
    for (const original of this.store.list()) {
      let issue = original;
      if (terminal(issue.stage) && issue.assignmentId === "") continue;
      if (
        issue.waiting === Waiting.Blocked &&
        issue.assignmentId === "" &&
        issue.nextAt > this.now()
      )
        continue;
      try {
        if (!terminal(issue.stage) && issue.nextAt <= this.now())
          issue = await this.refresh(issue);
        const policy = this.options.policy(issue.root);
        if (policy.hash !== issue.policyHash) {
          issue = {
            ...issue,
            policyHash: policy.hash,
            approvedVersion: 0,
            publicationVersion: 0,
            epoch: issue.epoch + 1,
            waiting:
              issue.waiting === Waiting.Paused
                ? Waiting.Paused
                : Waiting.Approval,
            detail: "Repository policy changed; reassessment required",
          };
          this.store.save(issue, "policy_changed", issue.detail);
        }
        if (issue.assignmentId.length > 0) {
          await this.poll(issue, policy);
          continue;
        }
        if (
          terminal(issue.stage) ||
          issue.externalClosed ||
          issue.waiting === Waiting.Paused ||
          issue.waiting === Waiting.Blocked
        )
          continue;
        if (issue.pendingComments.length > 0) {
          await this.dispatch(issue, policy, Role.Investigation, "comments");
          continue;
        }
        if (issue.waiting === Waiting.Clarification) {
          if (
            !issue.timeoutPlanned &&
            issue.clarificationDueAt !== undefined &&
            issue.clarificationDueAt <= this.now()
          )
            await this.dispatch(issue, policy, Role.Investigation, "timeout");
          continue;
        }
        if (
          issue.stage === IssueStage.Ready ||
          (issue.stage === IssueStage.Investigation && issue.brief != null)
        ) {
          if (canImplement(issue, policy)) {
            issue = {
              ...issue,
              stage: IssueStage.InProgress,
              waiting: Waiting.None,
            };
            this.store.save(
              issue,
              "implementation_ready",
              "Current brief authorized",
            );
          } else continue;
        }
        if (issue.waiting === Waiting.Approval) continue;
        if (issue.stage === IssueStage.InReview) {
          const status = this.options.codeHost.inspect(issue.prUrl);
          if (status == null) continue;
          if (status.merged) {
            issue = {
              ...issue,
              stage: IssueStage.Verification,
              prHead: status.head,
              detail: "Merge confirmed; acceptance verification required",
            };
            this.store.save(issue, "merged", issue.detail);
          } else if (status.closed) {
            this.store.save(
              {
                ...issue,
                waiting: Waiting.Blocked,
                detail: "Linked PR closed without merge",
              },
              "blocked",
              "PR closed",
            );
            continue;
          } else if (status.head !== issue.prHead && issue.prHead.length > 0) {
            this.store.save(
              { ...issue, stage: IssueStage.Testing, prHead: status.head },
              "head_changed",
              "Retest current PR head",
            );
            continue;
          } else if (status.checks === "failed" || status.feedback.length > 0) {
            this.store.save(
              {
                ...issue,
                stage: IssueStage.InProgress,
                detail: ["PR requires remediation", ...status.feedback].join(
                  "\n",
                ),
              },
              "rework",
              "Review or checks require changes",
            );
            continue;
          } else continue;
        }
        if (
          this.store
            .effects()
            .some(
              (effect) =>
                effect.issueId === issue.id &&
                ["commit", "publish"].includes(effect.kind),
            )
        )
          continue;
        if (
          issue.stage === IssueStage.Investigation ||
          issue.stage === IssueStage.InProgress ||
          issue.stage === IssueStage.Testing ||
          issue.stage === IssueStage.Verification
        )
          await this.dispatch(issue, policy, roleFor(issue.stage), "stage");
      } catch (error) {
        if (this.abort.signal.aborted) return;
        const current = this.store.get(issue.id);
        const detail =
          error instanceof Error
            ? error.message
            : "Issue operation unavailable";
        if (current.waiting !== Waiting.Blocked || current.detail !== detail)
          this.store.save(
            {
              ...current,
              waiting: Waiting.Blocked,
              nextAt: this.now() + Math.min(current.pollIntervalMs * 2, 900000),
              epoch: current.epoch + 1,
              detail,
            },
            "blocked",
            detail,
          );
        const assignment = this.store
          .assignments(issue.id)
          .find((item) => item.id === current.assignmentId);
        if (assignment !== undefined) {
          try {
            const stopped = await this.dispatcher(assignment).cancel(
              assignment,
              this.abort.signal,
            );
            if (!stopped) {
              this.store.assignment({
                ...assignment,
                state: AttemptState.Uncertain,
                detail: "Interrupt requested; terminal state unconfirmed",
              });
              continue;
            }
            this.store.assignment({
              ...assignment,
              state: AttemptState.Superseded,
            });
            this.store.save(
              { ...this.store.get(issue.id), assignmentId: "" },
              "assignment_stopped",
              detail,
            );
          } catch (cancelError) {
            this.store.assignment({
              ...assignment,
              state: AttemptState.Uncertain,
              detail:
                cancelError instanceof Error
                  ? cancelError.message
                  : "Cancellation unconfirmed",
            });
          }
        }
      }
    }
    await this.effects();
  }
  private async dispatch(
    issue: IssueRecord,
    policy: IssuePolicy,
    role: Role,
    purpose: Assignment["purpose"],
  ): Promise<void> {
    const active = this.store
      .assignments()
      .filter((item) =>
        [
          AttemptState.Intended,
          AttemptState.Running,
          AttemptState.Uncertain,
        ].includes(item.state),
      );
    if (active.length >= policy.concurrency) return;
    const profile = policy.profiles[role];
    if (
      !this.options.dispatchers.some((item) => item.harness === profile.harness)
    )
      throw new Error("Dispatcher profile unavailable");
    let workspace = issue.workspace;
    const previous =
      role === Role.Implementation
        ? this.store
            .assignments(issue.id)
            .filter(
              (item): boolean => item.role === role && item.sessionId !== "",
            )
            .at(-1)
        : undefined;
    const assignment: Assignment = {
      id: randomUUID(),
      issueId: issue.id,
      role,
      purpose,
      briefVersion: issue.brief?.version ?? 0,
      epoch: issue.epoch,
      state: AttemptState.Intended,
      sessionId: previous?.sessionId ?? "",
      turnId: "",
      workspace,
      profile,
      prompt: assignmentPrompt(issue, policy, purpose),
      result: undefined,
      createdAt: this.now(),
      updatedAt: this.now(),
      detail: "Dispatch intended",
    };
    this.store.atomic(() => {
      this.store.assignment(assignment);
      this.store.save(
        { ...issue, assignmentId: assignment.id, workspace },
        "dispatch_intended",
        assignment.id,
      );
    });
    try {
      if (workspace.length === 0 || role === Role.Verification) {
        workspace = await this.options.workspace.allocate(
          issue.root,
          issue.ownerId,
          issue.id,
        );
        assignment.workspace = workspace;
        this.store.assignment(assignment);
        this.store.save(
          { ...this.store.get(issue.id), workspace },
          "workspace_allocated",
          workspace,
        );
      }
      this.authorize(this.store.get(issue.id));
      const expected = { ...issue, assignmentId: assignment.id, workspace };
      this.authorize(expected);
      const status = await this.dispatcher(assignment).submit(
        assignment,
        (sessionId) => {
          assignment.sessionId = sessionId;
          this.store.assignment(assignment);
          this.authorize(expected);
        },
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
      );
      this.store.assignment({
        ...assignment,
        state:
          status.state === "running"
            ? AttemptState.Running
            : AttemptState.Uncertain,
        sessionId: status.sessionId,
        turnId: status.turnId,
        detail: status.detail,
        updatedAt: this.now(),
      });
    } catch (error) {
      this.store.assignment({
        ...assignment,
        state: AttemptState.Uncertain,
        detail: error instanceof Error ? error.message : "Dispatch unconfirmed",
        updatedAt: this.now(),
      });
    }
  }
  private async poll(issue: IssueRecord, policy: IssuePolicy): Promise<void> {
    const assignment = this.store
      .assignments(issue.id)
      .find((item) => item.id === issue.assignmentId);
    if (assignment == null) throw new Error("Assignment journal missing");
    const dispatcher = this.dispatcher(assignment);
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(30000),
    ]);
    if (
      assignment.epoch !== issue.epoch ||
      terminal(issue.stage) ||
      issue.waiting === Waiting.Paused
    ) {
      const stopped = await dispatcher.cancel(assignment, signal);
      if (!stopped) {
        this.store.assignment({
          ...assignment,
          state: AttemptState.Uncertain,
          detail: "Interrupt requested; waiting for terminal confirmation",
        });
        return;
      }
      this.store.assignment({ ...assignment, state: AttemptState.Superseded });
      this.store.save(
        { ...this.store.get(issue.id), assignmentId: "" },
        "assignment_superseded",
        assignment.id,
      );
      return;
    }
    if (this.now() - assignment.createdAt > assignment.profile.timeoutMs) {
      const stopped = await dispatcher.cancel(assignment, signal);
      if (!stopped) {
        this.store.assignment({
          ...assignment,
          state: AttemptState.Uncertain,
          detail: "Interrupt requested; waiting for terminal confirmation",
        });
        return;
      }
      this.store.assignment({ ...assignment, state: AttemptState.Cancelled });
      this.store.save(
        {
          ...this.store.get(issue.id),
          assignmentId: "",
          waiting:
            this.store.get(issue.id).epoch === assignment.epoch
              ? Waiting.Blocked
              : this.store.get(issue.id).waiting,
          detail:
            this.store.get(issue.id).epoch === assignment.epoch
              ? "Agent execution exceeded its timeout"
              : this.store.get(issue.id).detail,
        },
        "timeout",
        assignment.id,
      );
      return;
    }
    const status = await dispatcher.inspect(assignment, signal);
    const current = this.store.get(issue.id);
    if (
      current.epoch !== assignment.epoch ||
      current.assignmentId !== assignment.id ||
      current.waiting === Waiting.Paused ||
      terminal(current.stage)
    ) {
      this.store.assignment({
        ...assignment,
        state:
          status.state === "completed"
            ? AttemptState.Completed
            : status.state === "failed"
              ? AttemptState.Failed
              : AttemptState.Uncertain,
        sessionId: status.sessionId,
        turnId: status.turnId,
        result: status.result,
        detail: "Result observed after issue authority changed",
      });
      if (
        (status.state === "completed" || status.state === "failed") &&
        current.assignmentId === assignment.id
      ) {
        this.store.assignment({
          ...assignment,
          state: AttemptState.Superseded,
          result: status.result,
        });
        this.store.save(
          { ...current, assignmentId: "" },
          "assignment_superseded",
          assignment.id,
        );
      }
      return;
    }
    issue = current;
    policy = this.options.policy(issue.root);
    this.authorize(issue);
    const saved = {
      ...assignment,
      sessionId: status.sessionId,
      turnId: status.turnId,
      detail: status.detail,
      updatedAt: this.now(),
      state:
        status.state === "completed"
          ? AttemptState.Completed
          : status.state === "failed"
            ? AttemptState.Failed
            : status.state === "uncertain"
              ? AttemptState.Uncertain
              : AttemptState.Running,
      result: status.result,
    };
    this.store.assignment(saved);
    if (status.state === "failed") {
      this.store.save(
        {
          ...issue,
          assignmentId: "",
          waiting: Waiting.Blocked,
          detail: status.detail,
        },
        "agent_failed",
        assignment.id,
      );
      return;
    }
    if (status.state !== "completed" || status.result == null) return;
    try {
      this.complete(issue, saved, status.result, policy);
    } catch (error) {
      this.store.assignment({
        ...saved,
        state: AttemptState.Failed,
        detail: error instanceof Error ? error.message : "Invalid stage result",
      });
      this.store.save(
        {
          ...issue,
          assignmentId: "",
          waiting: Waiting.Blocked,
          detail:
            error instanceof Error ? error.message : "Invalid stage result",
        },
        "result_rejected",
        assignment.id,
      );
    }
  }
  private complete(
    issue: IssueRecord,
    assignment: Assignment,
    value: StageResult,
    policy: IssuePolicy,
  ): void {
    let next = applyResult(issue, assignment, value, policy);
    if (assignment.purpose === "comments")
      next = {
        ...next,
        pendingComments: [],
        reviewedComments: [
          ...issue.reviewedComments,
          ...issue.pendingComments.map((item) => `${item.id}:${item.revision}`),
        ],
      };
    if (
      next.waiting === Waiting.Clarification &&
      next.clarificationRound !== issue.clarificationRound
    ) {
      next.clarificationDueAt =
        policy.timeoutMs === undefined
          ? undefined
          : this.now() + policy.timeoutMs;
    }
    if (
      value.disposition === "brief" ||
      value.disposition === "clarification"
    ) {
      const brief = next.brief;
      if (brief == null) throw new Error("Brief missing");
      const immediate = policy.timeoutMs === 0 && brief.questions.length > 0;
      next.timeoutPlanned = next.timeoutPlanned || immediate;
      const body = `${next.timeoutPlanned ? "Remediation plan and assumptions" : "Investigation brief"} · version ${String(brief.version)}\n\n${brief.outcome}\n\nScope: ${brief.scope}\n\nAcceptance criteria:\n${brief.criteria.map((item) => `- ${item}`).join("\n")}\n\nAssumptions:\n${brief.assumptions.map((item) => `- ${item}`).join("\n")}\n\nClarification:\n${brief.questions.map((item) => `- ${item}`).join("\n")}\n\n${value.summary}`;
      this.queueEffect(issue, `brief:${String(brief.version)}`, "post", body);
      if (next.timeoutPlanned && canImplement(next, policy))
        next = { ...next, stage: IssueStage.Ready, waiting: Waiting.None };
    }
    if (value.disposition === "follow_up") {
      if (policy.followUps)
        this.queueEffect(
          issue,
          `followup:${assignment.id}`,
          "follow_up",
          value.followUpBody ?? "",
          value.followUpTitle ?? "",
        );
      else
        this.queueEffect(
          issue,
          `proposal:${assignment.id}`,
          "post",
          `Proposed follow-up: ${value.followUpTitle ?? ""}\n\n${value.followUpBody ?? ""}\n\nAwaiting approval.`,
        );
    }
    if (value.disposition === "implemented")
      this.queueEffect(
        next,
        `commit:${assignment.id}`,
        "commit",
        JSON.stringify({ version: next.brief?.version }),
      );
    if (
      value.disposition === "tested" &&
      value.draft !== undefined &&
      (policy.publish || next.publicationVersion === next.brief?.version)
    )
      this.queueEffect(
        next,
        `publish:${assignment.id}`,
        "publish",
        JSON.stringify({ version: next.brief?.version, result: value }),
      );
    if (value.disposition === "tested" && next.prUrl.length > 0)
      this.options.codeHost.enroll(next.prUrl, issue.ownerId, issue.workspace);
    this.store.save(
      next,
      "stage_result",
      `${value.disposition}: ${value.summary}`,
    );
    if (next.stage === IssueStage.Done)
      this.queueEffect(
        next,
        `done:${String(next.brief?.version ?? 0)}`,
        "close",
        "",
      );
  }
}
