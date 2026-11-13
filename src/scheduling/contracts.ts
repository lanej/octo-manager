import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

export enum RefreshKind {
  Tracking = "tracking",
  Reviews = "reviews",
}
export enum ScheduleState {
  Queued = "queued",
  Running = "running",
  Deferred = "deferred",
}
export const ScheduleSchema = Type.Object({
  key: Type.String(),
  kind: Type.Enum(RefreshKind),
  subject: Type.String(),
  dueAtMs: Type.Integer(),
  intervalMs: Type.Integer(),
  state: Type.Enum(ScheduleState),
  epoch: Type.Optional(Type.Integer()),
  signature: Type.Optional(Type.String()),
  active: Type.Optional(Type.Boolean()),
  lastAttemptAtMs: Type.Optional(Type.Integer()),
  lastError: Type.Optional(Type.String()),
  deferredReason: Type.Optional(Type.String()),
});
export type ScheduledRefresh = Static<typeof ScheduleSchema>;
const MessageSchema = Type.Object({
  id: Type.String(),
  url: Type.String(),
  author: Type.String(),
  kind: Type.String(),
  state: Type.String(),
  bodyMarkdown: Type.String(),
  atMs: Type.Integer(),
  path: Type.String(),
  line: Type.Optional(Type.Integer()),
  commitSha: Type.String(),
  bodyTruncated: Type.Boolean(),
});
export const ViewSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  state: Type.String(),
  headSha: Type.String(),
  observedAtMs: Type.Integer(),
  messages: Type.Array(MessageSchema),
  mayHaveMoreMessages: Type.Boolean(),
});
export const DispatchSchema = Type.Object({
  nextAtMs: Type.Integer(),
  coreRetryAtMs: Type.Integer(),
  graphqlRetryAtMs: Type.Integer(),
});
export function decode<T extends TSchema>(schema: T, data: string): Static<T>;
export function decode(schema: TSchema, data: string): unknown {
  const value: unknown = JSON.parse(data);
  if (!Check(schema, value))
    throw new Error("Invalid stored GitHub schedule data");
  return value;
}
export interface SchedulerPolicy {
  tickMs: number;
  requestSpacingMs: number;
}
export const defaultSchedulerPolicy: SchedulerPolicy = {
  tickMs: 1000,
  requestSpacingMs: 2000,
};
