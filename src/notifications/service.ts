import { resolveId } from "../tracking/identifiers.js";
import {
  CodexConnection,
  codexSocketPath,
  type QueueConnection,
  type QueuedMessage,
} from "../agents/codex.js";
import { DeliveryState, type AgentRef } from "../tracking/types.js";
import type { AgentMessage } from "../tracking/inbox.js";
import type { TrackingService } from "../tracking/service.js";
import type { SubmissionStore } from "../submissions/store.js";
import { DigestStore } from "./store.js";
import {
  DigestState as State,
  terminal,
  type Digest,
  type DigestRevision,
  type QueueTransport,
} from "./types.js";
import { renderDigest } from "./render.js";
export interface DigestOptions {
  connect?: (agent: AgentRef, socket: string) => QueueConnection;
  intervalMs?: number;
}
export class DigestService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  private stopped = false;
  private connections = new Set<QueueConnection>();
  private checks = new Map<string, { signature: string; at: number }>();
  constructor(
    readonly store: DigestStore,
    private tracking: TrackingService,
    private submissions: SubmissionStore,
    private directory: string,
    private now: () => number = Date.now,
    private options: DigestOptions = {},
  ) {
    store.recover();
  }
  managed = (agentId: string): boolean => {
    const agent = this.tracking.store.agent(agentId);
    return (
      this.tracking.config.endpoints[agent.endpoint]?.delivery === "queue" ||
      this.store
        .list(agentId)
        .some((value) => !terminal(value) || value.cleanupPending)
    );
  };
  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.options.intervalMs ?? 1000);
    this.flush().catch(() => {});
  }
  flush(): Promise<void> {
    if (this.work !== undefined) return this.work;
    if (this.stopped) return Promise.resolve();
    this.work = this.run().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  private pending(agentId: string): AgentMessage[] {
    return this.tracking.store.inbox.list(agentId, 0, false, true).messages;
  }
  private async run(): Promise<void> {
    for (const agent of this.tracking.store.agents()) {
      if (this.stopped) break;
      if (!this.managed(agent.id)) continue;
      const pending = this.pending(agent.id),
        active = this.store.active(agent.id),
        signature = JSON.stringify([
          pending.map((value) => value.id),
          active?.id,
          active?.revision,
          active?.state,
          this.tracking.config.endpoints[agent.endpoint],
        ]),
        previous = this.checks.get(agent.id);
      if (previous?.signature === signature && previous.at > this.now())
        continue;
      try {
        await this.sync(agent);
      } catch (error) {
        const current = this.store.active(agent.id),
          reason = (
            error instanceof Error
              ? error.message
              : "Queue reconciliation failed"
          ).slice(0, 1000);
        if (current !== undefined)
          this.store.save(
            {
              ...current,
              state:
                current.state === State.Ready ||
                current.state === State.Unavailable
                  ? State.Unavailable
                  : State.Uncertain,
              error: reason,
              nextCheckAt: this.now() + 5000,
            },
            "digest_uncertain",
            { reason },
          );
        else
          this.store.event(
            agent.id,
            undefined,
            "queue_inspection_unavailable",
            { reason },
          );
      }
      const fresh = this.store.active(agent.id),
        unread = this.pending(agent.id);
      const freshSignature = JSON.stringify([
        unread.map((value) => value.id),
        fresh?.id,
        fresh?.revision,
        fresh?.state,
        this.tracking.config.endpoints[agent.endpoint],
      ]);
      this.checks.set(agent.id, {
        signature: freshSignature,
        at: Math.max(
          this.now() + (unread.length > 0 || fresh !== undefined ? 1000 : 5000),
          fresh !== undefined &&
            (fresh.state === State.Uncertain ||
              fresh.state === State.Unavailable)
            ? fresh.nextCheckAt
            : 0,
        ),
      });
    }
  }
  private transport(agent: AgentRef): QueueTransport | undefined {
    const endpoint = this.tracking.config.endpoints[agent.endpoint];
    return endpoint?.delivery === "queue"
      ? { kind: "codex_queue", socket: codexSocketPath(endpoint.socket) }
      : undefined;
  }
  private draft(
    agent: AgentRef,
    transport: QueueTransport,
  ): Digest | undefined {
    const messages = this.pending(agent.id);
    if (messages.length === 0) return undefined;
    const render = (id: string, number: number) =>
      renderDigest(
        id,
        number,
        agent.id,
        messages,
        this.directory,
        this.tracking.store.agents().map((value) => value.id),
      );
    const active = this.store.active(agent.id);
    return active === undefined
      ? this.store.create(agent.id, transport, render)
      : this.store.revise(active, render);
  }
  private async sync(agent: AgentRef): Promise<void> {
    const desired = this.transport(agent);
    let active = this.store.active(agent.id);
    const cleanup = this.store
      .list(agent.id)
      .find((value) => terminal(value) && value.cleanupPending);
    const route = cleanup?.transport ?? active?.transport ?? desired;
    if (route === undefined) return;
    if (active === undefined && desired?.socket === route.socket)
      active = this.draft(agent, desired);
    const connection =
      this.options.connect?.(agent, route.socket) ??
      new CodexConnection(route.socket, "queue");
    this.connections.add(connection);
    try {
      const prepared = await connection.prepare(agent);
      if (prepared.version !== undefined)
        this.tracking.store.runtime(agent.id, prepared.version);
      const queued = await connection.queued(agent);
      const owned: {
        item: QueuedMessage;
        digest: Digest;
        version: DigestRevision;
      }[] = [];
      for (const item of queued) {
        const known = this.store
          .list(agent.id)
          .find(
            (value) =>
              value.transport.socket === route.socket &&
              this.store
                .revisions(value.id)
                .some((version) => version.dispatchId === item.clientId),
          );
        if (known !== undefined) {
          const version = this.store
            .revisions(known.id)
            .find(
              (value) =>
                value.dispatchId === item.clientId && value.body === item.body,
            );
          if (version === undefined) {
            this.store.event(agent.id, known.id, "queue_content_conflict", {
              queueId: item.queueId,
            });
            if (active?.id === known.id || known.cleanupPending)
              throw new Error("Managed queue content was edited outside Octo");
            continue;
          }
          if (terminal(known))
            await this.cancel(
              connection,
              agent,
              item,
              known.id,
              "received or cancelled digest",
            );
          else owned.push({ item, digest: known, version });
          continue;
        }
        const message = this.tracking.store.inbox.get(item.clientId);
        if (
          message === undefined ||
          message.id !== item.clientId ||
          message.recipientAgentId !== agent.id ||
          message.body !== item.body
        )
          continue;
        await this.cancel(
          connection,
          agent,
          item,
          active?.id,
          message.acknowledgedAt !== undefined
            ? "receipt already recorded"
            : !message.applicable
              ? "notification superseded"
              : "collapse legacy notification",
        );
      }
      for (const digest of this.store
        .list(agent.id)
        .filter((value) => value.transport.socket === route.socket))
        await this.reconcileLegacyWithdrawals(
          connection,
          agent,
          digest.id,
          queued,
        );
      for (const previous of this.store
        .list(agent.id)
        .filter(
          (value) =>
            terminal(value) &&
            value.cleanupPending &&
            value.transport.socket === route.socket,
        )) {
        for (const observed of owned.filter(
          (value) => value.digest.id === previous.id,
        ))
          await this.cancel(
            connection,
            agent,
            observed.item,
            previous.id,
            "receipt recorded during queue reconciliation",
          );
        const withdrawals = this.withdrawals(previous.id);
        if (withdrawals.length === 0) {
          this.store.save(
            { ...previous, cleanupPending: false },
            "digest_cleanup_confirmed",
            {},
          );
          continue;
        }
        const receipts = this.store.receipts(previous.id);
        const versions = this.store.revisions(previous.id),
          history = await connection.received(
            agent,
            versions.map((value) => value.body),
          );
        for (const withdrawal of withdrawals) {
          const version = versions.find(
            (value) => value.dispatchId === withdrawal.clientId,
          );
          if (
            version === undefined ||
            (!history.bodies.includes(version.body) &&
              !receipts.some(
                (receipt) => receipt.revision === version.revision,
              ))
          )
            throw new Error(
              "Previous digest withdrawal is unconfirmed; not adding a replacement",
            );
          this.acknowledge(
            previous.id,
            version.revision,
            agent.id,
            version.body,
          );
          this.store.event(agent.id, previous.id, "queue_cancel_reconciled", {
            queueId: withdrawal.queueId,
            revision: version.revision,
          });
        }
        this.store.save(
          { ...this.store.get(previous.id), cleanupPending: false },
          "digest_cleanup_confirmed",
          {},
        );
      }
      if (active === undefined || active.transport.socket !== route.socket)
        return;
      active = this.store.get(active.id);
      if (terminal(active)) return;
      const activeId = active.id;
      const present = owned
        .filter((value) => value.digest.id === activeId)
        .sort((a, b) => b.version.revision - a.version.revision);
      const keep = present[0];
      for (const duplicate of present.slice(1))
        await this.cancel(
          connection,
          agent,
          duplicate.item,
          active.id,
          "duplicate digest queue entry",
        );
      active = this.store.get(activeId);
      if (terminal(active)) return;
      const versions = this.store.revisions(active.id);
      if (keep === undefined) {
        const attempted = this.store
          .events(active.id)
          .some((event) => event.kind === "queue_enqueue_started");
        if (attempted) {
          const history = await connection.received(
            agent,
            versions.map((value) => value.body),
          );
          if (history.bodies.length > 0) {
            for (const body of history.bodies) {
              const version = versions.find((value) => value.body === body);
              if (version !== undefined)
                this.acknowledge(active.id, version.revision, agent.id, body);
            }
            return;
          }
          active = this.store.get(activeId);
          if (terminal(active)) return;
          if (
            desired === undefined ||
            desired.socket !== route.socket ||
            this.pending(agent.id).length === 0
          ) {
            this.store.save(
              { ...active, state: State.Cancelled, nextCheckAt: this.now() },
              "digest_cancelled",
              {
                reason: "No pending queue entry; receipt was not observed",
                historyComplete: history.complete,
              },
            );
            return;
          }
          if (!history.complete)
            throw new Error(
              "Receipt history is incomplete; not replaying an uncertain digest",
            );
          if (this.pendingWithdrawal(active.id))
            throw new Error(
              "Previous withdrawal is unconfirmed; not adding a replacement",
            );
        }
      }
      active = this.store.get(activeId);
      if (terminal(active)) return;
      if (
        keep === undefined &&
        this.pendingWithdrawal(active.id) &&
        this.pending(agent.id).length > 0
      )
        throw new Error(
          "Previous withdrawal is unconfirmed; not adding a replacement",
        );
      const messages = this.pending(agent.id),
        canSend = desired !== undefined && desired.socket === route.socket;
      if (!canSend || messages.length === 0) {
        if (keep !== undefined)
          await this.cancel(
            connection,
            agent,
            keep.item,
            active.id,
            !canSend
              ? "recipient transport changed"
              : "all messages superseded or received",
          );
        const fresh = this.store.get(active.id);
        if (!terminal(fresh))
          this.store.save(
            { ...fresh, state: State.Cancelled, nextCheckAt: this.now() },
            "digest_cancelled",
            {
              reason: canSend
                ? "No applicable unread messages"
                : "Transport changed",
            },
          );
        return;
      }
      active = this.store.revise(active, (id, number) =>
        renderDigest(
          id,
          number,
          agent.id,
          messages,
          this.directory,
          this.tracking.store.agents().map((value) => value.id),
        ),
      );
      let version = this.store.version(active.id, active.revision);
      if (keep !== undefined && keep.version.revision === version.revision) {
        const hadError = active.error !== undefined;
        delete active.error;
        if (
          active.state !== State.Queued ||
          active.queueId !== keep.item.queueId ||
          hadError
        )
          this.store.save(
            {
              ...active,
              state: State.Queued,
              queueId: keep.item.queueId,
              nextCheckAt: this.now() + 1000,
            },
            "digest_queue_observed",
            { revision: version.revision, queueId: keep.item.queueId },
          );
        this.accepted(version, keep.item.queueId);
        return;
      }
      if (keep !== undefined) {
        await this.cancel(
          connection,
          agent,
          keep.item,
          active.id,
          "replace digest revision",
        );
        const withdrawn = this.store.get(active.id);
        if (terminal(withdrawn)) return;
        delete withdrawn.queueId;
        this.store.save(
          { ...withdrawn, state: State.Ready },
          "digest_withdrawn",
          {
            oldRevision: keep.version.revision,
            nextRevision: version.revision,
          },
        );
      }
      active = this.store.get(active.id);
      if (terminal(active)) return;
      const latest = this.pending(agent.id),
        currentTransport = this.transport(agent);
      if (latest.length === 0 || currentTransport?.socket !== route.socket) {
        this.store.save(
          { ...active, state: State.Cancelled, nextCheckAt: this.now() },
          "digest_cancelled",
          { reason: "Membership or transport changed during withdrawal" },
        );
        return;
      }
      active = this.store.revise(active, (id, number) =>
        renderDigest(
          id,
          number,
          agent.id,
          latest,
          this.directory,
          this.tracking.store.agents().map((value) => value.id),
        ),
      );
      version = this.store.version(active.id, active.revision);
      const operation = "queue_enqueue";
      this.store.save(
        { ...active, state: State.Enqueueing, nextCheckAt: this.now() },
        operation + "_started",
        { revision: version.revision, dispatchId: version.dispatchId },
      );
      const result = await connection.enqueueQueued(
        agent,
        version.dispatchId,
        version.body,
      );
      if (
        result.clientId !== version.dispatchId ||
        result.body !== version.body
      )
        throw new Error("Queue admission did not confirm this digest revision");
      const queueId = result.queueId;
      const fresh = this.store.get(active.id);
      delete fresh.error;
      if (!terminal(fresh))
        this.store.save(
          {
            ...fresh,
            state: State.Queued,
            queueId,
            nextCheckAt: this.now() + 1000,
          },
          operation + "_confirmed",
          { revision: version.revision, queueId },
        );
      else
        this.store.event(
          agent.id,
          active.id,
          operation + "_confirmed_after_receipt",
          { revision: version.revision, queueId },
        );
      this.accepted(version, queueId);
    } finally {
      connection.close();
      this.connections.delete(connection);
    }
  }
  private async reconcileLegacyWithdrawals(
    connection: QueueConnection,
    agent: AgentRef,
    digestId: string,
    queued: QueuedMessage[],
  ): Promise<void> {
    const legacy = this.withdrawals(digestId).flatMap((withdrawal) => {
      const message = this.tracking.store.inbox.get(withdrawal.clientId);
      return message !== undefined &&
        message.id === withdrawal.clientId &&
        message.recipientAgentId === agent.id &&
        !queued.some((item) => item.queueId === withdrawal.queueId)
        ? [{ withdrawal, message }]
        : [];
    });
    if (legacy.length === 0) return;
    const unread = legacy.filter(
      (value) => value.message.acknowledgedAt === undefined,
    );
    const history: { bodies: string[] } =
      unread.length === 0
        ? { bodies: [] }
        : await connection.received(
            agent,
            unread.map((value) => value.message.body),
          );
    for (const { withdrawal, message } of legacy) {
      if (
        message.acknowledgedAt === undefined &&
        !history.bodies.includes(message.body)
      )
        continue;
      this.tracking.store.transaction(() => {
        this.tracking.store.acknowledgeMessageInside(message.id, agent.id);
        this.store.event(agent.id, digestId, "queue_cancel_reconciled", {
          queueId: withdrawal.queueId,
          clientId: message.id,
        });
      });
    }
  }
  private pendingWithdrawal(id: string): boolean {
    return this.withdrawals(id).length > 0;
  }
  private withdrawals(id: string): { queueId: string; clientId: string }[] {
    const pending = new Map<string, { queueId: string; clientId: string }>();
    for (const event of this.store.events(id)) {
      if (
        event.kind !== "queue_cancel_started" &&
        event.kind !== "queue_cancel_confirmed" &&
        event.kind !== "queue_cancel_reconciled"
      )
        continue;
      if (
        typeof event.detail !== "object" ||
        event.detail === null ||
        !("queueId" in event.detail) ||
        typeof event.detail.queueId !== "string"
      )
        throw new Error("Invalid withdrawal journal");
      if (event.kind === "queue_cancel_started") {
        if (
          !("clientId" in event.detail) ||
          typeof event.detail.clientId !== "string"
        )
          throw new Error("Invalid withdrawal identity");
        pending.set(event.detail.queueId, {
          queueId: event.detail.queueId,
          clientId: event.detail.clientId,
        });
      } else pending.delete(event.detail.queueId);
    }
    return [...pending.values()];
  }
  private async cancel(
    connection: QueueConnection,
    agent: AgentRef,
    item: QueuedMessage,
    digestId: string | undefined,
    reason: string,
  ): Promise<void> {
    const value = digestId === undefined ? undefined : this.store.get(digestId),
      detail = { queueId: item.queueId, clientId: item.clientId, reason };
    if (value !== undefined && !terminal(value))
      this.store.save(
        { ...value, state: State.Withdrawing },
        "queue_cancel_started",
        detail,
      );
    else this.store.event(agent.id, digestId, "queue_cancel_started", detail);
    try {
      const deleted = await connection.cancelQueued(agent, item.queueId);
      if (!deleted)
        throw new Error("Queue entry is no longer pending; reconcile receipt");
      this.store.event(agent.id, digestId, "queue_cancel_confirmed", {
        queueId: item.queueId,
        reason,
      });
    } catch (error) {
      this.store.event(agent.id, digestId, "queue_cancel_uncertain", {
        queueId: item.queueId,
        reason,
        error: error instanceof Error ? error.message : "Cancellation failed",
      });
      throw error;
    }
  }
  private accepted(version: DigestRevision, queueId: string): void {
    this.tracking.store.transaction(() => {
      for (const id of version.messageIds) {
        const message = this.tracking.store.inbox.get(id);
        if (message === undefined) throw new Error("Digest member disappeared");
        if (message.submissionId !== undefined) {
          const notice = this.submissions
            .notices(true)
            .find((value) => value.id === id);
          if (notice !== undefined && notice.state !== "accepted")
            this.submissions.saveNotice(
              notice,
              "accepted",
              "Included in an agent digest",
              this.now() + 30000,
            );
        } else if (message.applicable) {
          const delivery = this.tracking.store
            .deliveries()
            .find((value) => value.id === id);
          if (
            delivery !== undefined &&
            (delivery.progress.state !== DeliveryState.Delivered ||
              delivery.progress.queueId !== queueId)
          )
            this.tracking.store.saveDelivery(
              {
                ...delivery,
                progress: {
                  state: DeliveryState.Delivered,
                  at: this.now(),
                  queueId,
                  note: "Included in one queued digest; receipt pending.",
                },
                updatedAt: this.now(),
              },
              "delivery_delivered",
            );
        }
      }
    });
  }
  acknowledge(
    id: string,
    number: number,
    agentId: string,
    expectedBody?: string,
  ): AgentMessage[] {
    const value = this.store.get(id);
    const resolvedAgentId = resolveId(
      agentId,
      this.tracking.store.agents().map((agent) => agent.id),
    );
    if (value.agentId !== resolvedAgentId)
      throw new Error("Digest belongs to another agent");
    const version = this.store.version(value.id, number);
    if (expectedBody !== undefined && expectedBody !== version.body)
      throw new Error(
        "Invalid digest text; does not match the stored revision",
      );
    const messages = this.store.transaction(() => {
      const items = version.messageIds.map((messageId) =>
        this.tracking.store.acknowledgeMessageInside(messageId, value.agentId),
      );
      this.store.receiveInside(value, number);
      return items;
    });
    this.checks.delete(value.agentId);
    return messages;
  }
  inspect(id: string, number?: number) {
    const value = this.store.get(id);
    return {
      digest: value,
      revision: this.store.version(value.id, number ?? value.revision),
      revisions: this.store
        .revisions(value.id)
        .map((version) => version.revision),
      receipts: this.store.receipts(value.id),
      events: this.store.events(value.id).slice(-100),
    };
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const connection of this.connections) connection.close();
    await this.work;
  }
}
