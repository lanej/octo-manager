import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
export enum DigestState {
  Ready = "ready",
  Queued = "queued",
  Withdrawing = "withdrawing",
  Enqueueing = "enqueueing",
  Uncertain = "uncertain",
  Received = "received",
  Cancelled = "cancelled",
  Unavailable = "unavailable",
}
const text = () => Type.String({ minLength: 1 });
export const QueueTransportSchema = Type.Object(
  { kind: Type.Literal("codex_queue"), socket: text() },
  { additionalProperties: false },
);
export type QueueTransport = Static<typeof QueueTransportSchema>;
export const DigestSchema = Type.Object(
  {
    transport: QueueTransportSchema,
    cleanupPending: Type.Boolean(),
    id: text(),
    agentId: text(),
    state: Type.Enum(DigestState),
    revision: Type.Integer({ minimum: 1, maximum: 4294967295 }),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    nextCheckAt: Type.Integer(),
    queueId: Type.Optional(text()),
    error: Type.Optional(text()),
  },
  { additionalProperties: false },
);
export const RevisionSchema = Type.Object(
  {
    dispatchId: text(),
    digestId: text(),
    revision: Type.Integer({ minimum: 1, maximum: 4294967295 }),
    body: text(),
    messageIds: Type.Array(text(), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
    createdAt: Type.Integer(),
  },
  { additionalProperties: false },
);
export const DigestEventSchema = Type.Object(
  {
    sequence: Type.Integer(),
    digestId: Type.Optional(text()),
    agentId: text(),
    at: Type.Integer(),
    kind: text(),
    detail: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type Digest = Static<typeof DigestSchema>;
export type DigestRevision = Static<typeof RevisionSchema>;
export type DigestEvent = Static<typeof DigestEventSchema>;
export function digest(value: unknown): Digest {
  if (!Check(DigestSchema, value)) throw new Error("Invalid digest record");
  return value;
}
export function revision(value: unknown): DigestRevision {
  if (!Check(RevisionSchema, value)) throw new Error("Invalid digest revision");
  return value;
}
export function digestEvent(value: unknown): DigestEvent {
  if (!Check(DigestEventSchema, value)) throw new Error("Invalid digest event");
  return value;
}
export function terminal(value: Digest): boolean {
  return (
    value.state === DigestState.Received ||
    value.state === DigestState.Cancelled
  );
}
