import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { CheckWatchState } from "./checks.js";
import { ActionState, DeliveryState } from "./types.js";

const string = Type.String();
const number = Type.Integer();
const optionalString = Type.Optional(string);
const timestamp = { at: number };
const ids = { turnId: optionalString, queueId: optionalString };
const check = Type.Object({
  id: string,
  key: string,
  name: string,
  headSha: string,
  status: string,
  conclusion: string,
  at: number,
  url: string,
  workflowRunId: Type.Optional(number),
  workflowRunAttempt: Type.Optional(number),
  suiteId: Type.Optional(number),
  workflowId: Type.Optional(number),
  runNumber: Type.Optional(number),
  event: optionalString,
});
const feedback = Type.Object({
  source: Type.Union([Type.Literal("review"), Type.Literal("inline"), Type.Literal("conversation")]),
  id: string,
  revision: string,
  author: string,
  body: string,
  url: string,
  headSha: optionalString,
  path: optionalString,
  line: Type.Optional(number),
  reviewId: optionalString,
});

export const blocker = Type.Union([
  Type.Object({
    kind: Type.Literal("check_results"),
    watchId: string,
    headSha: string,
    state: Type.Union([Type.Literal(CheckWatchState.Completed), Type.Literal(CheckWatchState.Superseded)]),
    checks: Type.Array(check),
    replacementHeadSha: optionalString,
  }),
  Type.Object({ kind: Type.Literal("review_feedback"), feedback }),
  Type.Object({ kind: Type.Literal("conflict"), headSha: string, baseSha: string, baseRef: optionalString }),
  Type.Object({
    kind: Type.Literal("check_failed"),
    sourceId: string,
    checkName: string,
    headSha: string,
    checkKey: string,
  }),
  Type.Object({ kind: Type.Literal("changes_requested"), reviewId: string, reviewer: string, reviewedHeadSha: string }),
]);
export const profile = Type.Object({
  name: string,
  instructions: string,
  harness: optionalString,
  model: optionalString,
});
export const actionProgress = Type.Union([
  Type.Object({ state: Type.Literal(ActionState.Open) }),
  Type.Object({
    state: Type.Union([Type.Literal(ActionState.Acknowledged), Type.Literal(ActionState.Working)]),
    ...timestamp,
    agentId: string,
  }),
  Type.Object({ state: Type.Literal(ActionState.Resolved), ...timestamp, observationId: number, reason: string }),
  Type.Object({ state: Type.Literal(ActionState.Superseded), ...timestamp, reason: string }),
]);
export const deliveryProgress = Type.Union([
  Type.Object({ state: Type.Literal(DeliveryState.Pending), nextAttemptAt: number }),
  Type.Object({ state: Type.Literal(DeliveryState.Sending), startedAt: number }),
  Type.Object({ state: Type.Literal(DeliveryState.Delivered), ...timestamp, ...ids, note: optionalString }),
  Type.Object({
    state: Type.Union([
      Type.Literal(DeliveryState.Uncertain),
      Type.Literal(DeliveryState.Unavailable),
      Type.Literal(DeliveryState.Cancelled),
    ]),
    ...timestamp,
    reason: string,
  }),
]);
export const deliveryOutcome = Type.Union([
  Type.Object({ state: Type.Literal("sending") }),
  Type.Object({ state: Type.Literal("accepted"), ...timestamp, ...ids }),
  Type.Object({
    state: Type.Union([Type.Literal("rejected"), Type.Literal("uncertain")]),
    ...timestamp,
    reason: string,
  }),
]);

export function storedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid stored tracking text");
  return value;
}

export function storedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid stored tracking integer");
  return value;
}

export function stored<T extends TSchema>(schema: T, value: unknown): Static<T>;
export function stored(schema: TSchema, value: unknown): unknown {
  const decoded: unknown = JSON.parse(storedText(value));
  if (!Check(schema, decoded)) throw new Error("Invalid stored tracking record");
  return decoded;
}
