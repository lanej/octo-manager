import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { nextInboxSequence } from "../submissions/schema.js";
import { compact } from "../tracking/messages.js";
import { shortId, resolveId } from "../tracking/identifiers.js";
import type { TrackingStore } from "../tracking/store.js";
import type { TrackedPR } from "../tracking/types.js";
import {
  acyclic,
  feedbackKey,
  fingerprint,
  graphKey,
  references,
  type ReferenceSource,
} from "./policy.js";
import {
  ChainState,
  EntryState,
  OperationState,
  ReferenceDecision,
  ChainSchema,
  EntrySchema,
  OperationSchema,
  DependencySchema,
  ReferenceSchema,
  checked,
  terminal,
  type MergeChain,
  type MergeEntry,
  type MergeOperation,
  type Dependency,
  type PRReference,
  type QueueInput,
  type PreparationProfile,
} from "./contracts.js";
export class MergeStore {
  constructor(
    private db: DatabaseSync,
    readonly tracking: TrackingStore,
    readonly now: () => number,
    private event: (kind: string, detail: string, prId?: string) => void,
  ) {}
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private values(
    table:
      | "pr_references"
      | "pr_dependencies"
      | "merge_chains"
      | "merge_entries"
      | "merge_operations",
  ): unknown[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(String(row["data"])) as unknown);
  }
  chains(): MergeChain[] {
    return this.values("merge_chains").map((value) =>
      checked(ChainSchema, value),
    );
  }
  entries(): MergeEntry[] {
    return this.values("merge_entries").map((value) =>
      checked(EntrySchema, value),
    );
  }
  operations(): MergeOperation[] {
    return this.values("merge_operations").map((value) =>
      checked(OperationSchema, value),
    );
  }
  refs(): PRReference[] {
    return this.values("pr_references").map((value) =>
      checked(ReferenceSchema, value),
    );
  }
  dependencies(includeInactive = false): Dependency[] {
    return this.values("pr_dependencies")
      .map((value) => checked(DependencySchema, value))
      .filter((edge) => includeInactive || edge.active);
  }
  chain(id: string): MergeChain {
    const values = this.chains(),
      key = resolveId(
        id,
        values.map((item) => item.id),
      );
    const value = values.find((item) => item.id === key);
    if (value === undefined) throw new Error("Merge chain not found");
    return value;
  }
  entry(pr: string): MergeEntry {
    const p = this.tracking.pr(pr),
      value = this.entries().find(
        (item) => item.prId === p.id && !terminal(item.state),
      );
    if (value === undefined) throw new Error("Active merge entry not found");
    return value;
  }
  actor(id: string): string {
    const key = resolveId(
      id,
      this.tracking.agents().map((item) => item.id),
    );
    if (key === undefined) throw new Error("Agent not found");
    return key;
  }
  owner(pr: TrackedPR, actorId: string): string {
    const actor = this.actor(actorId);
    if (pr.ownerAgentId !== actor)
      throw new Error("PR belongs to another owner");
    return actor;
  }
  busy(prId: string): boolean {
    return this.operations().some(
      (op) =>
        op.prId === prId &&
        [
          OperationState.Planned,
          OperationState.Running,
          OperationState.Uncertain,
        ].includes(op.state),
    );
  }
  private editable(prId: string): void {
    if (this.busy(prId))
      throw new Error(
        "Reconcile the in-flight operation before editing merge policy",
      );
  }
  private writeChain(value: MergeChain): void {
    checked(ChainSchema, value);
    this.db
      .prepare(
        "INSERT INTO merge_chains VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(value.id, value.requestId, value.state, JSON.stringify(value));
  }
  saveEntry(value: MergeEntry): MergeEntry {
    checked(EntrySchema, value);
    this.db
      .prepare(
        "INSERT INTO merge_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(
        value.id,
        value.chainId,
        value.prId,
        value.state,
        JSON.stringify(value),
      );
    return value;
  }
  state(
    entry: MergeEntry,
    state: EntryState,
    detail: string,
    patch: Partial<MergeEntry> = {},
  ): MergeEntry {
    const current = this.entries().find((value) => value.id === entry.id);
    const next = {
      ...entry,
      ...patch,
      autoMerge: current?.autoMerge ?? entry.autoMerge,
      state,
      detail: compact(detail, 1000),
    };
    if (current !== undefined && current.autoMerge !== entry.autoMerge)
      delete next.ready;
    const comparable = (value: MergeEntry) => {
      return { ...value, nextAt: 0, version: 0 };
    };
    if (
      JSON.stringify(comparable(next)) === JSON.stringify(comparable(entry))
    ) {
      this.saveEntry(next);
      return next;
    }
    next.version = Math.max(entry.version, current?.version ?? 0) + 1;
    this.saveEntry(next);
    this.event("merge_entry_updated", `${state}: ${next.detail}`, entry.prId);
    const pr = this.tracking.pr(entry.prId);
    const body = `[PR #${new URL(pr.url).pathname.split("/").at(-1) ?? ""}](${pr.url}) · ${next.detail}\nMerge chain: ${shortId(entry.chainId)} · Entry: ${shortId(entry.id)}\nInspect: octo-manager chains ${shortId(entry.chainId)}`;
    this.notice(
      pr,
      "entry",
      entry.id,
      String(next.version),
      body,
      [
        EntryState.WaitingOwner,
        EntryState.Blocked,
        EntryState.Uncertain,
        EntryState.Merged,
      ].includes(state) &&
        (state === EntryState.Merged ||
          this.chain(entry.chainId).state === ChainState.Active),
    );
    return next;
  }
  queue(input: QueueInput): MergeChain {
    return this.transaction(() => {
      const digest = fingerprint(input),
        existing = this.chains().find(
          (chain) => chain.requestId === input.requestId,
        );
      if (existing !== undefined) {
        if (existing.inputDigest !== digest)
          throw new Error("Request ID already used with different merge input");
        return existing;
      }
      const actor = this.actor(input.actorId),
        prs = input.entries.map((item) => this.tracking.pr(item.prUrl));
      if (new Set(prs.map((pr) => pr.id)).size !== prs.length)
        throw new Error("Duplicate merge target");
      for (const pr of prs) {
        if (!pr.enabled) throw new Error("PR tracking is disabled");
        if (
          this.entries().some(
            (entry) => entry.prId === pr.id && !terminal(entry.state),
          )
        )
          throw new Error("PR already belongs to an active merge chain");
      }
      acyclic(this.dependencies());
      const at = this.now(),
        chain: MergeChain = {
          id: randomUUID(),
          requestId: input.requestId,
          actorId: actor,
          state: ChainState.Active,
          inputDigest: digest,
          createdAt: at,
          updatedAt: at,
        };
      this.writeChain(chain);
      input.entries.forEach((item, index) => {
        const pr = prs[index];
        if (pr === undefined) throw new Error("Missing merge target");
        if (item.noCi === true && (item.checks?.length ?? 0) > 0)
          throw new Error(
            "Choose expected checks or an explicit no-CI declaration",
          );
        this.saveEntry({
          id: randomUUID(),
          autoMerge: true,
          chainId: chain.id,
          prId: pr.id,
          method: item.method ?? "squash",
          checks: item.checks ?? [],
          noCi: item.noCi === true,
          state: EntryState.Waiting,
          detail: "Waiting for dependency and owner readiness",
          version: 1,
          nextAt: 0,
        });
      });
      this.event(
        "merge_chain_queued",
        `Queued ${String(prs.length)} explicitly authorized PRs`,
      );
      return chain;
    });
  }
  autoMerge(
    prValue: string,
    actorId: string,
    enabled: boolean,
    requestId: string,
  ) {
    return this.transaction(() => {
      const pr = this.tracking.pr(prValue);
      this.owner(pr, actorId);
      let entry = this.entries().find(
        (value) => value.prId === pr.id && !terminal(value.state),
      );
      if (entry === undefined && !enabled)
        return { prId: pr.id, enabled: false };
      if (entry === undefined) {
        const observation = pr.observation;
        const checks =
          observation === undefined
            ? []
            : [
                ...new Set(
                  [observation.checks, observation.workflows].flatMap((part) =>
                    part === undefined || part.state !== "complete"
                      ? []
                      : part.value.map((check) => check.name),
                  ),
                ),
              ];
        this.queue({
          requestId,
          actorId,
          entries: [{ prUrl: pr.url, checks }],
        });
        entry = this.entry(pr.id);
      }
      if (entry.autoMerge === enabled) return { prId: pr.id, enabled, entry };
      const next = { ...entry, autoMerge: enabled, nextAt: 0 };
      delete next.ready;
      this.saveEntry(next);
      const saved = this.state(
        next,
        this.busy(pr.id)
          ? entry.state
          : enabled
            ? EntryState.WaitingOwner
            : EntryState.Waiting,
        enabled
          ? "Auto-merge on; owner assessment required"
          : "Auto-merge off; an accepted GitHub operation may still finish",
      );
      this.event("auto_merge_changed", enabled ? "on" : "off", pr.id);
      return { prId: pr.id, enabled, entry: saved };
    });
  }
  control(id: string, state: ChainState): MergeChain {
    return this.transaction(() => {
      const chain = this.chain(id);
      if (
        chain.state === ChainState.Completed ||
        chain.state === ChainState.Cancelled
      )
        throw new Error("Merge chain is terminal");
      const next = { ...chain, state, updatedAt: this.now() };
      this.writeChain(next);
      if (state !== ChainState.Active)
        this.db
          .prepare(
            "UPDATE merge_notices SET applicable=0 WHERE subject_kind='entry' AND subject_id IN (SELECT id FROM merge_entries WHERE chain_id=?)",
          )
          .run(chain.id);
      if (state === ChainState.Cancelled)
        for (const entry of this.entries().filter(
          (item) => item.chainId === chain.id && !terminal(item.state),
        ))
          if (!this.busy(entry.prId))
            this.state(entry, EntryState.Cancelled, "Merge chain cancelled");
      if (state === ChainState.Active && chain.state === ChainState.Paused) {
        for (const entry of this.entries().filter(
          (item) => item.chainId === chain.id && !terminal(item.state),
        )) {
          const next = { ...entry, version: entry.version + 1, nextAt: 0 };
          this.saveEntry(next);
          const pr = this.tracking.pr(entry.prId);
          this.notice(
            pr,
            "entry",
            entry.id,
            String(next.version),
            `[PR #${new URL(pr.url).pathname.split("/").at(-1) ?? ""}](${pr.url}) · ${entry.detail}\nMerge chain: ${shortId(chain.id)}\nInspect: octo-manager chains ${shortId(chain.id)}`,
            [
              EntryState.WaitingOwner,
              EntryState.Blocked,
              EntryState.Uncertain,
            ].includes(entry.state),
          );
        }
      }
      this.event("merge_chain_control", state);
      return next;
    });
  }
  completeChains(): void {
    for (const chain of this.chains().filter(
      (item) => item.state === ChainState.Active,
    )) {
      const entries = this.entries().filter(
        (item) => item.chainId === chain.id,
      );
      if (
        entries.length > 0 &&
        entries.every((item) => item.state === EntryState.Merged)
      ) {
        this.writeChain({
          ...chain,
          state: ChainState.Completed,
          updatedAt: this.now(),
        });
        this.event("merge_chain_completed", "All selected PRs merged");
      }
    }
  }
  confirm(
    prValue: string,
    prerequisiteValue: string,
    actorId: string,
    reason: string,
    referenceId?: string,
    preparation?: PreparationProfile,
  ): Dependency {
    return this.transaction(() => {
      const pr = this.tracking.pr(prValue),
        upstream = this.tracking.pr(prerequisiteValue),
        actor = this.owner(pr, actorId);
      this.editable(pr.id);
      if (pr.id === upstream.id) throw new Error("Self dependency rejected");
      if (
        preparation !== undefined &&
        new URL(pr.url).pathname
          .split("/")
          .slice(1, 3)
          .join("/")
          .toLowerCase() !== preparation.repository.toLowerCase()
      )
        throw new Error("Preparation repository does not match PR");
      const prior = this.dependencies(true).find(
        (edge) =>
          edge.dependentId === pr.id && edge.prerequisiteId === upstream.id,
      );
      const edge: Dependency = {
        id: prior?.id ?? randomUUID(),
        dependentId: pr.id,
        prerequisiteId: upstream.id,
        confirmedBy: actor,
        active: true,
        reason,
        ...(referenceId === undefined ? {} : { referenceId }),
        ...(preparation === undefined ? {} : { preparation }),
      };
      acyclic([
        ...this.dependencies().filter((item) => item.id !== edge.id),
        edge,
      ]);
      if (referenceId !== undefined) {
        const reference = this.refs().find((item) => item.id === referenceId);
        if (
          reference === undefined ||
          reference.prId !== pr.id ||
          reference.targetUrl.replace("/issues/", "/pull/") !== upstream.url
        )
          throw new Error("Reference does not establish this dependency pair");
        this.db
          .prepare(
            "UPDATE merge_notices SET applicable=0 WHERE subject_kind='reference' AND subject_id=?",
          )
          .run(reference.id);
        this.saveReference({
          ...reference,
          decision: ReferenceDecision.Confirmed,
          decidedBy: actor,
        });
      }
      this.saveDependency(edge);
      this.invalidate(pr.id);
      this.event(
        "dependency_confirmed",
        `${pr.url} waits for ${upstream.url}`,
        pr.id,
      );
      return edge;
    });
  }
  private saveDependency(edge: Dependency): void {
    checked(DependencySchema, edge);
    this.db
      .prepare(
        "INSERT INTO pr_dependencies VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        edge.id,
        edge.dependentId,
        edge.prerequisiteId,
        JSON.stringify(edge),
      );
  }
  removeDependency(id: string, actorId: string): Dependency {
    return this.transaction(() => {
      const edge = this.dependencies().find((item) => item.id === id);
      if (edge === undefined) throw new Error("Dependency not found");
      const actor = this.owner(this.tracking.pr(edge.dependentId), actorId);
      this.editable(edge.dependentId);
      const next = {
        ...edge,
        active: false,
        removedBy: actor,
        removedAt: this.now(),
      };
      this.saveDependency(next);
      this.invalidate(edge.dependentId);
      this.event("dependency_removed", id, edge.dependentId);
      return next;
    });
  }
  private invalidate(prId: string): void {
    for (const entry of this.entries().filter(
      (item) => item.prId === prId && !terminal(item.state),
    )) {
      delete entry.ready;
      this.state(
        entry,
        EntryState.Waiting,
        "Dependency or merge policy changed; owner readiness required",
      );
    }
  }
  configure(
    prValue: string,
    actorId: string,
    checks: string[],
    noCi: boolean,
  ): MergeEntry {
    return this.transaction(() => {
      const pr = this.tracking.pr(prValue);
      this.owner(pr, actorId);
      this.editable(pr.id);
      if ((noCi && checks.length > 0) || (!noCi && checks.length === 0))
        throw new Error("Declare expected checks or explicit no CI");
      const entry = this.entry(pr.id);
      delete entry.ready;
      return this.state(
        entry,
        EntryState.WaitingOwner,
        "Check policy changed; owner readiness required",
        { checks, noCi },
      );
    });
  }
  ready(prValue: string, actorId: string, head: string): MergeEntry {
    return this.transaction(() => {
      const pr = this.tracking.pr(prValue),
        owner = this.owner(pr, actorId);
      this.editable(pr.id);
      const observation = pr.observation;
      if (
        !pr.enabled ||
        observation === undefined ||
        observation.headSha !== head
      )
        throw new Error("Readiness head does not match current enrolled PR");
      const feedback = feedbackKey(observation);
      if (feedback === undefined)
        throw new Error(
          "Complete review evidence is required before marking ready",
        );
      const entry = this.entry(pr.id);
      if (!entry.autoMerge) throw new Error("Auto-merge is off");
      if (this.chain(entry.chainId).state !== ChainState.Active)
        throw new Error("Merge chain is not active");
      return this.state(
        entry,
        EntryState.WaitingChecks,
        "Owner assessed this head; waiting for GitHub checks",
        {
          ready: {
            epoch: pr.trackingEpoch,
            head,
            baseRef: observation.targetBase?.ref ?? "",
            ownerId: owner,
            feedback,
            graph: graphKey(this.dependencies(), pr.id),
            at: this.now(),
          },
          nextAt: 0,
          preparationHold: false,
        },
      );
    });
  }
  saveOperation(value: MergeOperation): void {
    checked(OperationSchema, value);
    const previous = this.operations().find((op) => op.id === value.id);
    if (
      previous?.requestId !== undefined &&
      previous.requestId !== value.requestId
    )
      throw new Error("Asynchronous request identity is immutable");
    if (
      previous !== undefined &&
      fingerprint([
        previous.epoch,
        previous.preparationKey,
        previous.entryId,
        previous.prId,
        previous.kind,
        previous.head,
        previous.baseRef,
        previous.baseSha,
        previous.graph,
        previous.ownerId,
        previous.preparation,
        previous.prerequisiteCommit,
      ]) !==
        fingerprint([
          value.epoch,
          value.preparationKey,
          value.entryId,
          value.prId,
          value.kind,
          value.head,
          value.baseRef,
          value.baseSha,
          value.graph,
          value.ownerId,
          value.preparation,
          value.prerequisiteCommit,
        ])
    )
      throw new Error("Operation identity and inputs are immutable");
    this.db
      .prepare(
        "INSERT INTO merge_operations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(
        value.id,
        value.entryId,
        value.prId,
        value.state,
        JSON.stringify(value),
      );
  }
  recover(): void {
    for (const op of this.operations())
      if (
        op.state === OperationState.Running ||
        op.state === OperationState.Planned
      ) {
        if (op.kind === "merge" && op.requestId !== undefined) continue;
        const local = op.kind === "prepare" && op.phase === "local";
        this.saveOperation({
          ...op,
          state: local ? OperationState.Failed : OperationState.Uncertain,
          detail: local
            ? "Local preparation interrupted before push; owner assessment required"
            : "Interrupted external operation; reconcile before retrying",
          updatedAt: this.now(),
        });
        const entry = this.entries().find((item) => item.id === op.entryId);
        if (entry !== undefined) {
          const fresh = { ...entry };
          delete fresh.ready;
          this.state(
            fresh,
            local
              ? this.chain(entry.chainId).state === ChainState.Cancelled
                ? EntryState.Cancelled
                : EntryState.WaitingOwner
              : EntryState.Uncertain,
            local
              ? "Preparation interrupted; owner assessment required"
              : "External operation outcome unknown",
            local ? { preparationHold: true } : {},
          );
        }
      }
  }
  private saveReference(value: PRReference): void {
    checked(ReferenceSchema, value);
    this.db
      .prepare(
        "INSERT INTO pr_references VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, value.prId, value.targetUrl, JSON.stringify(value));
  }
  decide(
    id: string,
    actorId: string,
    decision: "related" | "dismissed",
  ): PRReference {
    return this.transaction(() => {
      const ref = this.refs().find((item) => item.id === id);
      if (ref === undefined) throw new Error("Reference not found");
      const actor = this.owner(this.tracking.pr(ref.prId), actorId),
        next = {
          ...ref,
          decision:
            decision === "related"
              ? ReferenceDecision.Related
              : ReferenceDecision.Dismissed,
          decidedBy: actor,
        };
      this.saveReference(next);
      this.db
        .prepare(
          "UPDATE merge_notices SET applicable=0 WHERE subject_kind='reference' AND subject_id=?",
        )
        .run(ref.id);
      this.event("reference_decided", decision, ref.prId);
      return next;
    });
  }
  scan(pr: TrackedPR): void {
    const observation = pr.observation;
    if (observation === undefined) return;
    const sources: ReferenceSource[] = [];
    if (observation.description !== undefined)
      sources.push({
        key: "description",
        text: observation.description,
        url: pr.url,
      });
    if (observation.feedback?.state === "complete")
      for (const item of observation.feedback.value)
        sources.push({
          key: `${item.source}:${item.id}`,
          text: item.body,
          url: item.url,
        });
    const found = references(pr, sources, this.tracking.prs()),
      seen = new Set(found.map((ref) => ref.id));
    this.transaction(() => {
      for (const prior of this.refs().filter(
        (ref) => ref.prId === pr.id && ref.active,
      )) {
        const complete =
          prior.sourceKey === "description"
            ? observation.description !== undefined
            : observation.feedback?.state === "complete";
        if (complete && !seen.has(prior.id)) {
          this.saveReference({ ...prior, active: false });
          this.db
            .prepare(
              "UPDATE merge_notices SET applicable=0 WHERE subject_kind='reference' AND subject_id=?",
            )
            .run(prior.id);
        }
      }
      for (const ref of found) {
        const prior = this.refs().find((item) => item.id === ref.id);
        if (prior === undefined)
          this.saveReference({
            ...ref,
            active: true,
            decision: ReferenceDecision.Suggested,
            createdAt: this.now(),
          });
        else if (!prior.active) this.saveReference({ ...prior, active: true });
        const current = this.refs().find((item) => item.id === ref.id);
        if (current?.decision === ReferenceDecision.Suggested) {
          const number = new URL(pr.url).pathname.split("/").at(-1) ?? "";
          this.notice(
            pr,
            "reference",
            ref.id,
            ref.revision,
            `[PR #${number}](${pr.url}) · ${ref.hint === "depends_on" ? "Possible dependency" : "PR reference"}: ${ref.targetUrl}\n> ${ref.excerpt}\n[Evidence](${ref.evidenceUrl})\nInspect: octo-manager references ${pr.url}`,
            true,
          );
        }
      }
    });
  }
  notice(
    pr: TrackedPR,
    kind: "reference" | "entry",
    subjectId: string,
    revision: string,
    body: string,
    applicable: boolean,
  ): void {
    this.transaction(() => {
      for (const participant of this.tracking.subscriptions.list(pr)) {
        this.db
          .prepare(
            "UPDATE merge_notices SET applicable=0 WHERE subject_kind=? AND subject_id=? AND recipient_agent_id=? AND revision!=?",
          )
          .run(kind, subjectId, participant.agentId, revision);
        if (!applicable) continue;
        if (
          this.db
            .prepare(
              "SELECT 1 FROM merge_notices WHERE subject_kind=? AND subject_id=? AND recipient_agent_id=? AND revision=?",
            )
            .get(kind, subjectId, participant.agentId, revision) !== undefined
        )
          continue;
        this.db
          .prepare(
            "INSERT OR IGNORE INTO merge_notices VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            nextInboxSequence(this.db),
            randomUUID(),
            pr.id,
            participant.agentId,
            kind,
            subjectId,
            revision,
            compact(body, 6000),
            this.now(),
            null,
            this.now(),
            1,
          );
      }
    });
  }
  inspect(id?: string) {
    const chains = id === undefined ? this.chains() : [this.chain(id)],
      ids = new Set(chains.map((chain) => chain.id)),
      entries = this.entries().filter((entry) => ids.has(entry.chainId)),
      entryIds = new Set(entries.map((entry) => entry.id));
    return {
      chains,
      entries,
      operations: this.operations().filter((op) => entryIds.has(op.entryId)),
      dependencies: this.dependencies(),
    };
  }
}
