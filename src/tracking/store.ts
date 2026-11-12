import { actionableFeedback } from "./review-signals.js";
import { resolveId } from "./identifiers.js";
import {
  CheckWatches,
  CheckWatchState,
  storedCheckEvidence,
  successfulCheck,
} from "./checks.js";
import { AgentInbox } from "./inbox.js";
import { storedFeedback } from "./feedback.js";
import { actionContext, targetBase } from "./evidence.js";
import type { ActionEventContext } from "./types.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  ActionState,
  DeliveryState,
  unfinished,
  type Action,
  type AgentRef,
  type AgentTarget,
  type Delivery,
  type DeliveryAttempt,
  type ObservationInput,
  type PRObservation,
  type TrackedPR,
  type TrackingSnapshot,
} from "./types.js";
import type { TrackingConfig } from "./config.js";
import { selectProfile } from "./config.js";
import { canonicalPR } from "./github.js";
import { closeProgress, findings } from "./policy.js";
import { migrateTracking } from "./schema.js";
type Row = Record<string, any>;
const parse = (s: unknown): any => JSON.parse(s as string);
export class TrackingStore {
  readonly inbox: AgentInbox;
  readonly checks: CheckWatches;
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private event: (
      kind: string,
      detail: string,
      prId: string,
      actionId?: string,
      context?: ActionEventContext,
    ) => void,
  ) {
    migrateTracking(db);
    this.inbox = new AgentInbox(db, now);
    this.checks = new CheckWatches(db, now);
    this.transaction(() => {
      for (const action of this.actions()) {
        if (
          unfinished(action) &&
          ((action.blocker.kind === "check_results" &&
            action.blocker.state === CheckWatchState.Superseded) ||
            (action.blocker.kind === "review_feedback" &&
              !actionableFeedback(action.blocker.feedback)))
        ) {
          this.saveAction(
            {
              ...action,
              progress: {
                state: ActionState.Superseded,
                at: this.now(),
                reason: "Informational update retained in observation history",
              },
              updatedAt: this.now(),
            },
            "action_superseded",
          );
          this.cancelDeliveries(action.id, "Informational update");
        }
      }
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  agents(): AgentRef[] {
    return this.db
      .prepare("SELECT * FROM agent_refs ORDER BY rowid")
      .all()
      .map((r: Row) => ({
        id: r.id,
        harness: r.harness,
        endpoint: r.endpoint,
        sessionId: r.session_id,
        ...(r.label === null ? {} : { label: r.label }),
        ...(r.harness_version === null
          ? {}
          : {
              lastObservedRuntime: {
                version: r.harness_version,
                observedAt: r.version_observed_at_ms,
              },
            }),
      }));
  }
  agent(id: string): AgentRef {
    const a = this.agents().find((a) => a.id === id);
    if (!a) throw new Error("Agent not found");
    return a;
  }
  registerAgent(t: AgentTarget): AgentRef {
    return this.transaction(() => this.register(t));
  }
  private register(t: AgentTarget): AgentRef {
    if (
      t.harness !== "codex" ||
      !t.endpoint ||
      !t.sessionId ||
      t.sessionId.length > 200 ||
      t.endpoint.length > 200 ||
      (t.label?.length ?? 0) > 200
    )
      throw new Error("Invalid or unsupported agent target");
    this.db
      .prepare(
        "INSERT INTO agent_refs(id,harness,endpoint,session_id,label) VALUES(?,?,?,?,?) ON CONFLICT(harness,endpoint,session_id) DO NOTHING",
      )
      .run(randomUUID(), t.harness, t.endpoint, t.sessionId, t.label ?? null);
    return this.agents().find(
      (a) =>
        a.harness === t.harness &&
        a.endpoint === t.endpoint &&
        a.sessionId === t.sessionId,
    )!;
  }
  runtime(id: string, version: string): void {
    this.db
      .prepare(
        "UPDATE agent_refs SET harness_version=?,version_observed_at_ms=? WHERE id=?",
      )
      .run(version, this.now(), id);
  }
  private observation(r: Row): PRObservation {
    const target = targetBase(r["target_base_json"]);
    const feedback = storedFeedback(r["feedback_json"]);
    const workflows = storedCheckEvidence(r["workflow_runs_json"]);
    return {
      id: r.id,
      prId: r.pr_id,
      observedAt: r.observed_at_ms,
      headSha: r.head_sha,
      baseSha: r.base_sha,
      ...(target === undefined ? {} : { targetBase: target }),
      lifecycle: r.lifecycle,
      mergeability: r.mergeability,
      checks: parse(r.checks_json),
      reviews: parse(r.reviews_json),
      ...(feedback === undefined ? {} : { feedback }),
      ...(workflows === undefined ? {} : { workflows }),
    };
  }
  prs(): TrackedPR[] {
    return this.db
      .prepare("SELECT * FROM tracked_prs ORDER BY rowid")
      .all()
      .map((r: Row) => {
        const o = this.db
          .prepare(
            "SELECT * FROM pr_observations WHERE pr_id=? ORDER BY id DESC LIMIT 1",
          )
          .get(r.id);
        return {
          id: r.id,
          url: r.url,
          originAgentId: r.origin_agent_id,
          ownerAgentId: r.owner_agent_id,
          enabled: !!r.enabled,
          createdAt: r.created_at_ms,
          updatedAt: r.updated_at_ms,
          ...(r.last_refresh_error === null
            ? {}
            : {
                lastRefreshError: {
                  at: r.last_refresh_error_at_ms,
                  message: r.last_refresh_error,
                },
              }),
          ...(o ? { observation: this.observation(o) } : {}),
        };
      });
  }
  pr(id: string): TrackedPR {
    const p = this.prs().find((p) => p.id === id || p.url === id);
    if (!p) throw new Error("Tracked PR not found");
    return p;
  }
  track(url: string, target: AgentTarget): TrackedPR {
    return this.transaction(() => {
      url = canonicalPR(url);
      const agent = this.register(target);
      const existing = this.prs().find((p) => p.url === url);
      if (existing) {
        if (existing.ownerAgentId !== agent.id)
          throw new Error("PR already has another owner; use assign");
        if (!existing.enabled) {
          this.db
            .prepare(
              "UPDATE tracked_prs SET enabled=1,updated_at_ms=? WHERE id=?",
            )
            .run(this.now(), existing.id);
          this.event("pr_retracked", "Tracking resumed", existing.id);
          for (const a of this.actions().filter(
            (a) =>
              a.prId === existing.id && a.progress.state === ActionState.Open,
          ))
            this.enqueue(a);
        }
        return this.pr(existing.id);
      }
      const id = randomUUID(),
        at = this.now();
      this.db
        .prepare(
          "INSERT INTO tracked_prs(id,url,origin_agent_id,owner_agent_id,enabled,created_at_ms,updated_at_ms) VALUES(?,?,?,?,1,?,?)",
        )
        .run(id, url, agent.id, agent.id, at, at);
      this.event("pr_tracked", "PR enrolled", id);
      return this.pr(id);
    });
  }
  actions(): Action[] {
    return this.db
      .prepare("SELECT * FROM actions ORDER BY rowid")
      .all()
      .map((r: Row) => ({
        id: r.id,
        prId: r.pr_id,
        openedObservationId: r.opened_observation_id,
        ownerAgentId: r.owner_agent_id,
        sourceKey: r.source_key,
        blocker: parse(r.blocker_json),
        summary: r.summary,
        evidenceUrl: r.evidence_url,
        profile: parse(r.profile_json),
        progress: parse(r.progress_json),
        createdAt: r.created_at_ms,
        updatedAt: r.updated_at_ms,
      }));
  }
  action(id: string): Action {
    const actions = this.actions();
    const resolved = resolveId(
      id,
      actions.map((action) => action.id),
    );
    const a = actions.find((action) => action.id === resolved);
    if (!a) throw new Error("Action not found");
    return a;
  }
  private saveAction(a: Action, kind: string): void {
    this.db
      .prepare(
        `INSERT INTO actions(id,pr_id,opened_observation_id,owner_agent_id,kind,source_key,blocker_json,summary,evidence_url,profile_json,state,progress_json,resolved_observation_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_agent_id=excluded.owner_agent_id,profile_json=excluded.profile_json,state=excluded.state,progress_json=excluded.progress_json,resolved_observation_id=excluded.resolved_observation_id,updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        a.id,
        a.prId,
        a.openedObservationId,
        a.ownerAgentId,
        a.blocker.kind,
        a.sourceKey,
        JSON.stringify(a.blocker),
        a.summary,
        a.evidenceUrl,
        JSON.stringify(a.profile),
        a.progress.state,
        JSON.stringify(a.progress),
        a.progress.state === ActionState.Resolved
          ? a.progress.observationId
          : null,
        a.createdAt,
        a.updatedAt,
      );
    const actor =
      kind === "action_progress" && "agentId" in a.progress
        ? this.agent(a.progress.agentId)
        : undefined;
    const context = actionContext({
      state: a.progress.state,
      prUrl: this.pr(a.prId).url,
      ...(actor === undefined
        ? {}
        : {
            actorAgentId: actor.id,
            actorHarness: actor.harness,
            actorSessionId: actor.sessionId,
            ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
          }),
    });
    this.event(kind, a.summary, a.prId, a.id, context);
  }
  deliveries(): Delivery[] {
    return this.db
      .prepare("SELECT * FROM deliveries ORDER BY rowid")
      .all()
      .map((r: Row) => ({
        id: r.id,
        actionId: r.action_id,
        recipientAgentId: r.recipient_agent_id,
        retryCount: r.retry_count,
        progress: parse(r.progress_json),
        createdAt: r.created_at_ms,
        updatedAt: r.updated_at_ms,
      }));
  }
  attempts(): DeliveryAttempt[] {
    return this.db
      .prepare("SELECT * FROM delivery_attempts ORDER BY rowid")
      .all()
      .map((r: Row) => ({
        deliveryId: r.delivery_id,
        number: r.number,
        startedAt: r.started_at_ms,
        ...(r.harness_version === null
          ? {}
          : { harnessVersion: r.harness_version }),
        outcome: parse(r.outcome_json),
      }));
  }
  saveDelivery(d: Delivery, kind: string): void {
    this.db
      .prepare(
        "INSERT INTO deliveries(id,action_id,recipient_agent_id,state,progress_json,next_attempt_at_ms,created_at_ms,updated_at_ms,retry_count) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,progress_json=excluded.progress_json,next_attempt_at_ms=excluded.next_attempt_at_ms,updated_at_ms=excluded.updated_at_ms,retry_count=excluded.retry_count",
      )
      .run(
        d.id,
        d.actionId,
        d.recipientAgentId,
        d.progress.state,
        JSON.stringify(d.progress),
        d.progress.state === DeliveryState.Pending
          ? d.progress.nextAttemptAt
          : null,
        d.createdAt,
        d.updatedAt,
        d.retryCount ?? 0,
      );
    const a = this.action(d.actionId);
    this.event(kind, d.id, a.prId, a.id);
  }
  saveAttempt(a: DeliveryAttempt): void {
    this.db
      .prepare(
        "INSERT INTO delivery_attempts(delivery_id,number,started_at_ms,harness_version,outcome,outcome_json) VALUES(?,?,?,?,?,?) ON CONFLICT(delivery_id,number) DO UPDATE SET harness_version=excluded.harness_version,outcome=excluded.outcome,outcome_json=excluded.outcome_json",
      )
      .run(
        a.deliveryId,
        a.number,
        a.startedAt,
        a.harnessVersion ?? null,
        a.outcome.state,
        JSON.stringify(a.outcome),
      );
  }
  private enqueue(a: Action): void {
    const at = this.now();
    this.saveDelivery(
      {
        id: randomUUID(),
        actionId: a.id,
        recipientAgentId: a.ownerAgentId,
        progress: { state: DeliveryState.Pending, nextAttemptAt: at },
        createdAt: at,
        updatedAt: at,
      },
      "delivery_pending",
    );
  }
  private cancelDeliveries(actionId: string, reason: string): void {
    for (const d of this.deliveries().filter(
      (d) =>
        d.actionId === actionId &&
        [
          DeliveryState.Pending,
          DeliveryState.Sending,
          DeliveryState.Uncertain,
          DeliveryState.Unavailable,
        ].includes(d.progress.state),
    ))
      this.saveDelivery(
        {
          ...d,
          progress: { state: DeliveryState.Cancelled, at: this.now(), reason },
          updatedAt: this.now(),
        },
        "delivery_cancelled",
      );
  }
  assign(id: string, target: AgentTarget): TrackedPR {
    return this.transaction(() => {
      const p = this.pr(id),
        agent = this.register(target);
      if (p.ownerAgentId === agent.id) return p;
      this.db
        .prepare(
          "UPDATE tracked_prs SET owner_agent_id=?,updated_at_ms=? WHERE id=?",
        )
        .run(agent.id, this.now(), p.id);
      for (const a of this.actions().filter(
        (a) => a.prId === p.id && unfinished(a),
      )) {
        this.cancelDeliveries(a.id, "Ownership reassigned");
        const next = {
          ...a,
          ownerAgentId: agent.id,
          progress: { state: ActionState.Open } as const,
          updatedAt: this.now(),
        };
        this.saveAction(next, "action_reassigned");
        if (p.enabled) this.enqueue(next);
      }
      this.event("pr_assigned", "Ownership reassigned", p.id);
      return this.pr(p.id);
    });
  }
  untrack(id: string): TrackedPR {
    return this.transaction(() => {
      const p = this.pr(id);
      this.db
        .prepare("UPDATE tracked_prs SET enabled=0,updated_at_ms=? WHERE id=?")
        .run(this.now(), p.id);
      for (const a of this.actions().filter((a) => a.prId === p.id))
        this.cancelDeliveries(a.id, "PR untracked");
      this.checks.cancel(p.id);
      this.event("pr_untracked", "Tracking disabled", p.id);
      return this.pr(p.id);
    });
  }
  observe(
    id: string,
    input: ObservationInput,
    config: TrackingConfig,
  ): TrackedPR {
    return this.transaction(() => {
      const p = this.pr(id);
      if (!p.enabled) return p;
      const result = this.db
        .prepare(
          "INSERT INTO pr_observations(pr_id,observed_at_ms,head_sha,base_sha,lifecycle,mergeability,checks_state,checks_json,reviews_state,reviews_json,target_base_json,feedback_json,workflow_runs_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          p.id,
          input.observedAt,
          input.headSha,
          input.baseSha,
          input.lifecycle,
          input.mergeability,
          input.checks.state,
          JSON.stringify(input.checks),
          input.reviews.state,
          JSON.stringify(input.reviews),
          input.targetBase === undefined
            ? null
            : JSON.stringify(input.targetBase),
          input.feedback === undefined ? null : JSON.stringify(input.feedback),
          input.workflows === undefined
            ? null
            : JSON.stringify(input.workflows),
        );
      const o: PRObservation = {
        ...input,
        id: Number(result.lastInsertRowid),
        prId: p.id,
      };
      this.db
        .prepare(
          "UPDATE tracked_prs SET last_refresh_error=NULL,last_refresh_error_at_ms=NULL,updated_at_ms=? WHERE id=?",
        )
        .run(this.now(), p.id);
      this.event("pr_observed", `Observed head ${o.headSha}`, p.id);
      for (const a of this.actions().filter(
        (a) => a.prId === p.id && unfinished(a),
      )) {
        const progress = closeProgress(a, o, this.now());
        if (progress) {
          this.saveAction(
            { ...a, progress, updatedAt: this.now() },
            `action_${progress.state}`,
          );
          this.cancelDeliveries(a.id, "Action no longer outstanding");
        }
      }
      const observedFindings = findings(o, p.url);
      const checkResults = this.checks.observe(o).flatMap((watch) => {
        const checks =
          watch.evidence.state === "unavailable" ? [] : watch.evidence.value;
        const failures = checks.filter((check) => !successfulCheck(check));
        const reported = [
          ...this.actions().filter((action) => action.prId === p.id),
          ...observedFindings,
        ];
        const unreported = failures.filter(
          (check) =>
            !reported.some((finding) => {
              const blocker = finding.blocker;
              if (blocker.kind === "check_results")
                return (
                  blocker.headSha === watch.headSha &&
                  blocker.checks.some(
                    (previous) =>
                      previous.id === check.id &&
                      previous.conclusion === check.conclusion,
                  )
                );
              if (
                blocker.kind !== "check_failed" ||
                blocker.headSha !== watch.headSha
              )
                return false;
              if (blocker.sourceId === check.id) return true;
              const job = checks.find(
                (candidate) => candidate.id === blocker.sourceId,
              );
              const run = (url: string) =>
                /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/.exec(
                  url,
                )?.[0];
              return (
                job !== undefined &&
                job.at >= check.at &&
                run(job.url) !== undefined &&
                run(job.url) === run(check.url)
              );
            }),
        );
        if (
          watch.state !== CheckWatchState.Completed ||
          (unreported.length === 0 &&
            (failures.length > 0 || o.lifecycle !== "open"))
        )
          return [];
        return [
          {
            sourceKey: watch.id,
            blocker: {
              kind: "check_results" as const,
              watchId: watch.id,
              headSha: watch.headSha,
              state: watch.state,
              checks: failures.length === 0 ? checks : unreported,
              ...(watch.replacementHeadSha === undefined
                ? {}
                : { replacementHeadSha: watch.replacementHeadSha }),
            },
            summary:
              failures.length === 0
                ? `${checks.every((check) => check.conclusion === "success") ? "Checks passed" : "Checks completed (includes neutral/skipped)"}; ${o.mergeability === "mergeable" ? "no merge conflicts" : o.mergeability === "conflicting" ? "merge conflict remains" : "conflict status unknown"}`
                : unreported.length === 1
                  ? `Failed check: ${unreported[0]?.name ?? "workflow"}`
                  : `${String(unreported.length)} failed checks: ${unreported[0]?.name ?? "workflow"}`,
            evidenceUrl: p.url,
          },
        ];
      });
      for (const f of [...findings(o, p.url), ...checkResults]) {
        if (
          this.actions().some(
            (a) =>
              a.prId === p.id &&
              a.blocker.kind === f.blocker.kind &&
              a.sourceKey === f.sourceKey &&
              (f.blocker.kind === "review_feedback" ||
                f.blocker.kind === "check_results" ||
                unfinished(a)),
          )
        )
          continue;
        const at = this.now(),
          a: Action = {
            id: randomUUID(),
            prId: p.id,
            openedObservationId: o.id,
            ownerAgentId: p.ownerAgentId,
            ...f,
            profile: selectProfile(f.blocker, config),
            progress: { state: ActionState.Open },
            createdAt: at,
            updatedAt: at,
          };
        this.saveAction(a, "action_opened");
        this.enqueue(a);
      }
      return this.pr(p.id);
    });
  }
  refreshError(id: string, message: string): void {
    this.transaction(() => {
      const p = this.pr(id);
      this.db
        .prepare(
          "UPDATE tracked_prs SET last_refresh_error=?,last_refresh_error_at_ms=? WHERE id=?",
        )
        .run(message, this.now(), p.id);
      this.event("pr_refresh_failed", message, p.id);
    });
  }
  progress(id: string, agentId: string, working: boolean): Action {
    return this.transaction(() => {
      const a = this.action(id);
      if (!unfinished(a)) throw new Error("Action is closed");
      if (a.ownerAgentId !== agentId)
        throw new Error("Action belongs to another agent");
      if (working && a.progress.state === ActionState.Open)
        throw new Error("Acknowledge action before starting work");
      if (
        a.progress.state === ActionState.Working ||
        (!working && a.progress.state === ActionState.Acknowledged)
      )
        return a;
      const next: Action = {
        ...a,
        progress: {
          state: working ? ActionState.Working : ActionState.Acknowledged,
          at: this.now(),
          agentId,
        },
        updatedAt: this.now(),
      };
      this.saveAction(next, "action_progress");

      return next;
    });
  }
  acknowledgeMessage(id: string, agentId: string) {
    return this.transaction(() => {
      const before = this.inbox.get(id);
      const message = this.inbox.acknowledge(id, agentId);
      if (before?.acknowledgedAt === undefined) {
        const action = this.action(message.actionId);
        this.event("message_acknowledged", message.id, action.prId, action.id);
      }
      return message;
    });
  }
  retryDelivery(id: string): Delivery {
    return this.transaction(() => {
      const d = this.deliveries().find((d) => d.id === id);
      if (!d) throw new Error("Delivery not found");
      const a = this.action(d.actionId);
      if (this.inbox.get(id)?.acknowledgedAt !== undefined)
        throw new Error("Message already acknowledged");
      if (
        !this.pr(a.prId).enabled ||
        !unfinished(a) ||
        a.ownerAgentId !== d.recipientAgentId
      )
        throw new Error("Delivery no longer applicable");
      if (
        ![DeliveryState.Unavailable, DeliveryState.Uncertain].includes(
          d.progress.state,
        )
      )
        throw new Error(
          "Only unavailable or uncertain deliveries can be retried",
        );
      const next = {
        ...d,
        retryCount: 0,
        progress: {
          state: DeliveryState.Pending,
          nextAttemptAt: this.now(),
        } as const,
        updatedAt: this.now(),
      };
      this.saveDelivery(next, "delivery_retry_requested");
      return next;
    });
  }
  reprofile(id: string, config: TrackingConfig): Action {
    return this.transaction(() => {
      const a = this.action(id);
      if (!unfinished(a)) throw new Error("Action is closed");
      const next = {
        ...a,
        profile: selectProfile(a.blocker, config),
        updatedAt: this.now(),
      };
      this.saveAction(next, "action_reprofiled");
      return next;
    });
  }
  snapshot(): TrackingSnapshot {
    return {
      prs: this.prs(),
      agents: this.agents(),
      actions: this.actions(),
      deliveries: this.deliveries(),
      attempts: this.attempts(),
      checkWatches: this.checks.list(),
    };
  }
}
