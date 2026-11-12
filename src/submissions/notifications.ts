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
  if (!Check(NoticeSchema, value))
    throw new Error("Invalid operation notification");
  return value;
}
export class SubmissionNotifications {
  private work: Promise<void> | undefined;
  private connection: AgentConnection | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(
    private store: SubmissionStore,
    private tracking: TrackingService,
    private connect?: (agent: AgentRef) => AgentConnection,
  ) {
    store.recoverNotices();
  }
  start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
    this.tick();
  }
  private tick(): void {
    if (this.stopped || this.work !== undefined) return;
    this.work = this.deliver()
      .catch(() => {})
      .finally(() => {
        this.work = undefined;
      });
  }
  private async deliver(): Promise<void> {
    const notice = this.store
      .notices()
      .find((value) => value.nextCheckAt <= Date.now());
    if (notice === undefined) return;
    const agent = this.tracking.store.agent(notice.recipient),
      endpoint = this.tracking.config.endpoints[agent.endpoint];
    if (endpoint === undefined) {
      this.store.saveNotice(
        notice,
        "unavailable",
        "Recipient endpoint is not configured",
        Date.now() + 30000,
      );
      return;
    }
    const connection =
      this.connect?.(agent) ??
      new CodexConnection(endpoint.socket, endpoint.delivery);
    this.connection = connection;
    try {
      const prepared = await connection.prepare(agent);
      const previous = await connection.find(agent, notice.id, notice.body);
      if (previous.received === true) {
        this.tracking.store.acknowledgeMessage(notice.id, agent.id);
        return;
      }
      if (previous.found) {
        this.store.saveNotice(
          notice,
          "accepted",
          "Agent receipt pending",
          Date.now() + 30000,
        );
        return;
      }
      if (!this.store.noticeApplicable(notice.id)) return;
      if (prepared.busy) {
        this.store.saveNotice(
          notice,
          notice.state,
          "Caller is busy",
          Date.now() + 30000,
        );
        return;
      }
      this.store.saveNotice(
        notice,
        "sending",
        "Sending to caller",
        Date.now() + 30000,
      );
      const sent = await connection.send(agent, notice.id, notice.body);
      this.store.saveNotice(
        notice,
        "accepted",
        sent.queueId ?? sent.turnId ?? "Queue accepted",
        Date.now() + 30000,
      );
      if (sent.received === true)
        this.tracking.store.acknowledgeMessage(notice.id, agent.id);
    } catch (error) {
      this.store.saveNotice(
        notice,
        "uncertain",
        (error instanceof Error ? error.message : "Delivery unavailable").slice(
          0,
          500,
        ),
        Date.now() + 30000,
      );
    } finally {
      connection.close();
      this.connection = undefined;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.connection?.close();
    await this.work;
  }
}
