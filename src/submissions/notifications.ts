import type { ScheduledTask, WorkScheduler } from "../scheduling/work.js";
import { Check } from "typebox/value";
import { Type } from "typebox";

import type { SubmissionStore } from "./store.js";
import type { TrackingService } from "../tracking/service.js";
import { CodexConnection, type AgentConnection } from "../agents/codex.js";
import type { AgentRef } from "../tracking/types.js";

export const NoticeSchema = Type.Object(
  {
    id: Type.String(),
    submissionId: Type.String(),
    recipient: Type.String(),
    body: Type.String(),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("sending"),
      Type.Literal("accepted"),
      Type.Literal("uncertain"),
      Type.Literal("unavailable"),
    ]),
    attempts: Type.Array(
      Type.Object({
        at: Type.Integer(),
        state: Type.String(),
        detail: Type.String(),
      }),
    ),
    nextCheckAt: Type.Integer(),
  },
  { additionalProperties: false },
);
export type Notice = import("typebox").Static<typeof NoticeSchema>;

export function parseNotice(value: unknown): Notice {
  if (!Check(NoticeSchema, value)) throw new Error("Invalid operation notification");
  return value;
}

export class SubmissionNotifications {
  private work: Promise<void> | undefined;
  private connection: AgentConnection | undefined;
  private task: ScheduledTask | undefined;
  private stopped = false;

  constructor(
    private store: SubmissionStore,
    private tracking: TrackingService,
    private connect?: (agent: AgentRef) => AgentConnection,
    private managedQueue?: (agentId: string) => boolean,
  ) {
    store.recoverNotices();
  }

  start(scheduler: WorkScheduler): void {
    this.task = scheduler.task("submission-notifications", async () => {
      if (this.stopped) return;
      const attempted = this.store
        .notices()
        .find(
          (value) =>
            value.nextCheckAt <= Date.now() &&
            this.managedQueue?.(value.recipient) !== true &&
            this.store.noticeApplicable(value.id),
        );
      this.work = !attempted ? Promise.resolve() : this.deliver(attempted);
      try {
        await this.work;
      } finally {
        this.work = undefined;
      }
      let next = Infinity;
      for (const value of this.store.notices())
        if (this.managedQueue?.(value.recipient) !== true && this.store.noticeApplicable(value.id)) {
          const stalled =
            value.id === attempted?.id && value.nextCheckAt <= attempted.nextCheckAt && value.nextCheckAt <= Date.now();
          next = Math.min(next, stalled ? Date.now() + 30000 : value.nextCheckAt);
        }
      return Number.isFinite(next) ? next : undefined;
    });
    this.wake();
  }

  wake(): void {
    this.task?.wake();
  }

  private async deliver(notice: Notice): Promise<void> {
    const agent = this.tracking.store.agent(notice.recipient),
      endpoint = this.tracking.config.endpoints[agent.endpoint];
    if (!endpoint) {
      this.store.saveNotice(notice, "unavailable", "Recipient endpoint is not configured", Date.now() + 30000);
      return;
    }
    const connection = this.connect?.(agent) ?? new CodexConnection(endpoint.socket, endpoint.delivery);
    this.connection = connection;
    try {
      const prepared = await connection.prepare(agent);
      const previous = await connection.find(agent, notice.id, notice.body);
      if (previous.received === true) {
        this.tracking.store.acknowledgeMessage(notice.id, agent.id);
        return;
      }
      if (previous.found) {
        this.store.saveNotice(notice, "accepted", "Agent receipt pending", Date.now() + 30000);
        return;
      }
      if (!this.store.noticeApplicable(notice.id)) return;
      if (prepared.busy) {
        this.store.saveNotice(notice, notice.state, "Caller is busy", Date.now() + 30000);
        return;
      }
      this.store.saveNotice(notice, "sending", "Sending to caller", Date.now() + 30000);
      const message = this.tracking.store.inbox.get(notice.id);
      if (!message || this.tracking.store.inbox.automatic(message).body !== notice.body) {
        this.store.saveNotice(
          notice,
          "unavailable",
          "Legacy notification requires explicit inspection",
          Date.now() + 300000,
        );
        return;
      }
      const sent = await connection.send(agent, notice.id, notice.body);
      this.store.saveNotice(notice, "accepted", sent.queueId ?? sent.turnId ?? "Queue accepted", Date.now() + 30000);
      if (sent.received === true) this.tracking.store.acknowledgeMessage(notice.id, agent.id);
    } catch (error) {
      this.store.saveNotice(
        notice,
        "uncertain",
        (error instanceof Error ? error.message : "Delivery unavailable").slice(0, 500),
        Date.now() + 30000,
      );
    } finally {
      connection.close();
      this.connection = undefined;
    }
  }

  checkpointable(): boolean {
    return this.work === undefined;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.task?.close();
    this.connection?.close();
    await this.work;
  }
}
