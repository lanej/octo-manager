import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
export enum ChainState {
  Active = "active",
  Paused = "paused",
  Cancelled = "cancelled",
  Completed = "completed",
}
export enum EntryState {
  Waiting = "waiting",
  Preparing = "preparing",
  WaitingOwner = "waiting_owner",
  WaitingChecks = "waiting_checks",
  Ready = "ready",
  Merging = "merging",
  Merged = "merged",
  Blocked = "blocked",
  Uncertain = "uncertain",
  Cancelled = "cancelled",
}
export enum OperationState {
  Planned = "planned",
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
  Uncertain = "uncertain",
}
export enum ReferenceDecision {
  Suggested = "suggested",
  Confirmed = "confirmed",
  Related = "related",
  Dismissed = "dismissed",
}
const text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const Sha = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
export const Method = Type.Union([
  Type.Literal("squash"),
  Type.Literal("merge"),
  Type.Literal("rebase"),
]);
export const PreparationProfileSchema = object({
  kind: Type.Union([Type.Literal("rebase"), Type.Literal("toml_revision")]),
  repository: Type.String({
    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    maxLength: 200,
  }),
  checks: Type.Array(Type.Array(text(4000), { minItems: 1, maxItems: 100 }), {
    minItems: 1,
    maxItems: 20,
  }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 1800000 }),
  path: Type.Optional(text(1000)),
  key: Type.Optional(
    Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), {
      minItems: 1,
      maxItems: 20,
    }),
  ),
  expectedValue: Type.Optional(Sha),
});
export type PreparationProfile = Static<typeof PreparationProfileSchema>;
export const ReferenceSchema = object({
  id: text(),
  prId: text(),
  targetUrl: text(2000),
  targetKind: Type.Union([Type.Literal("pr"), Type.Literal("issue_or_pr")]),
  sourceKey: text(300),
  revision: text(),
  evidenceUrl: text(2000),
  excerpt: text(480),
  hint: Type.Union([Type.Literal("depends_on"), Type.Literal("mentioned")]),
  active: Type.Boolean(),
  decision: Type.Enum(ReferenceDecision),
  createdAt: Type.Integer(),
  decidedBy: Type.Optional(text()),
});
export type PRReference = Static<typeof ReferenceSchema>;
export const DependencySchema = object({
  id: text(),
  dependentId: text(),
  prerequisiteId: text(),
  confirmedBy: text(),
  active: Type.Boolean(),
  removedBy: Type.Optional(text()),
  removedAt: Type.Optional(Type.Integer()),
  reason: text(1000),
  referenceId: Type.Optional(text()),
  preparation: Type.Optional(PreparationProfileSchema),
});
export type Dependency = Static<typeof DependencySchema>;
export const ReadySchema = object({
  epoch: Type.Integer(),
  head: Sha,
  baseRef: text(300),
  ownerId: text(),
  feedback: text(),
  graph: text(),
  at: Type.Integer(),
});
export const EntryInputSchema = object({
  prUrl: text(2000),
  method: Type.Optional(Method),
  checks: Type.Optional(
    Type.Array(text(300), { maxItems: 50, uniqueItems: true }),
  ),
  noCi: Type.Optional(Type.Boolean()),
});
export const QueueInputSchema = object({
  requestId: text(),
  actorId: text(),
  entries: Type.Array(EntryInputSchema, { minItems: 1, maxItems: 50 }),
});
export type QueueInput = Static<typeof QueueInputSchema>;
export const ChainSchema = object({
  id: text(),
  requestId: text(),
  actorId: text(),
  state: Type.Enum(ChainState),
  inputDigest: text(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type MergeChain = Static<typeof ChainSchema>;
export const EntrySchema = object({
  autoMerge: Type.Boolean(),
  id: text(),
  chainId: text(),
  prId: text(),
  method: Method,
  checks: Type.Array(text(300), { maxItems: 50 }),
  noCi: Type.Boolean(),
  state: Type.Enum(EntryState),
  detail: Type.String({ maxLength: 1000 }),
  version: Type.Integer({ minimum: 1 }),
  nextAt: Type.Integer(),
  ready: Type.Optional(ReadySchema),
  preparationHold: Type.Optional(Type.Boolean()),
  preparedKey: Type.Optional(text()),
  preparedHead: Type.Optional(Sha),
  mergeCommit: Type.Optional(Sha),
});
export type MergeEntry = Static<typeof EntrySchema>;
export const OperationSchema = object({
  requestId: Type.Optional(text()),
  nextCheckAt: Type.Optional(Type.Integer()),
  epoch: Type.Integer(),
  id: text(),
  entryId: text(),
  prId: text(),
  kind: Type.Union([Type.Literal("prepare"), Type.Literal("merge")]),
  state: Type.Enum(OperationState),
  phase: Type.Union([
    Type.Literal("local"),
    Type.Literal("pushing"),
    Type.Literal("merging"),
  ]),
  head: Sha,
  baseRef: text(300),
  baseSha: Sha,
  graph: text(),
  ownerId: text(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  detail: Type.String({ maxLength: 2000 }),
  resultHead: Type.Optional(Sha),
  mergeCommit: Type.Optional(Sha),
  preparation: Type.Optional(PreparationProfileSchema),
  prerequisiteCommit: Type.Optional(Sha),
  preparationKey: Type.Optional(text()),
  workspace: Type.Optional(text(4000)),
});
export type MergeOperation = Static<typeof OperationSchema>;
const actor = { actorId: text() };
export const CommandSchema = Type.Union([
  object({
    op: Type.Literal("auto_merge"),
    pr: text(2000),
    enabled: Type.Boolean(),
    actorId: text(),
    requestId: text(),
  }),
  object({ op: Type.Literal("queue"), input: QueueInputSchema }),
  object({ op: Type.Literal("inspect"), id: Type.Optional(text()) }),
  object({ op: Type.Literal("references"), pr: Type.Optional(text(2000)) }),
  object({ op: Type.Literal("dependencies"), pr: Type.Optional(text(2000)) }),
  object({
    op: Type.Literal("confirm"),
    pr: text(2000),
    prerequisite: text(2000),
    ...actor,
    reason: text(1000),
    referenceId: Type.Optional(text()),
    profile: Type.Optional(text()),
  }),
  object({ op: Type.Literal("remove"), id: text(), ...actor }),
  object({
    op: Type.Literal("decide"),
    id: text(),
    ...actor,
    decision: Type.Union([Type.Literal("related"), Type.Literal("dismissed")]),
  }),
  object({
    op: Type.Literal("policy"),
    pr: text(2000),
    ...actor,
    checks: Type.Array(text(300), { maxItems: 50, uniqueItems: true }),
    noCi: Type.Boolean(),
  }),
  object({ op: Type.Literal("ready"), pr: text(2000), head: Sha, ...actor }),
  object({ op: Type.Literal("pause"), id: text() }),
  object({ op: Type.Literal("resume"), id: text() }),
  object({ op: Type.Literal("cancel"), id: text() }),
  object({ op: Type.Literal("reconcile"), id: text() }),
]);
export type MergeCommand = Static<typeof CommandSchema>;
export function checked<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T>;
export function checked(schema: TSchema, value: unknown): unknown {
  if (!Check(schema, value)) throw new Error("Invalid merge-chain data");
  return value;
}
export function terminal(state: EntryState): boolean {
  return state === EntryState.Merged || state === EntryState.Cancelled;
}

export class EffectNotStarted extends Error {}
