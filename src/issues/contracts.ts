import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
export enum IssueStage {
  Investigation = "investigation",
  Ready = "ready",
  InProgress = "in_progress",
  Testing = "testing",
  InReview = "in_review",
  Verification = "verification",
  Done = "done",
  Cancelled = "cancelled",
}
export enum Waiting {
  None = "none",
  Clarification = "needs_clarification",
  Blocked = "blocked",
  Approval = "awaiting_approval",
  Paused = "paused",
}
export enum Role {
  Investigation = "investigation",
  Implementation = "implementation",
  Verification = "verification",
}
export enum AttemptState {
  Intended = "intended",
  Running = "running",
  Uncertain = "uncertain",
  Completed = "completed",
  Cancelled = "cancelled",
  Failed = "failed",
  Superseded = "superseded",
}
const text = Type.String({ maxLength: 16000 });
const short = Type.String({ maxLength: 1000 });
export const ReferenceSchema = Type.Object({
  provider: short,
  project: short,
  externalId: short,
  url: short,
});
export type IssueReference = Static<typeof ReferenceSchema>;
export const CommentSchema = Type.Object({
  id: short,
  revision: short,
  author: short,
  body: text,
  url: short,
});
export type IssueComment = Static<typeof CommentSchema>;
export const BriefSchema = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  outcome: text,
  scope: text,
  criteria: Type.Array(short, { maxItems: 50 }),
  assumptions: Type.Array(short, { maxItems: 50 }),
  questions: Type.Array(short, { maxItems: 50 }),
  blockingQuestions: Type.Boolean(),
});
export type Brief = Static<typeof BriefSchema>;
export const ResultSchema = Type.Object({
  disposition: Type.Union([
    Type.Literal("brief"),
    Type.Literal("clarification"),
    Type.Literal("implemented"),
    Type.Literal("tested"),
    Type.Literal("verified"),
    Type.Literal("rework"),
    Type.Literal("blocked"),
    Type.Literal("no_change"),
    Type.Literal("follow_up"),
  ]),
  summary: text,
  evidence: Type.Array(short, { maxItems: 50 }),
  draft: Type.Optional(Type.Object({ title: short, body: text })),
  brief: Type.Optional(BriefSchema),
  prUrl: Type.Optional(short),
  head: Type.Optional(short),
  followUpTitle: Type.Optional(short),
  followUpBody: Type.Optional(text),
});
export type StageResult = Static<typeof ResultSchema>;
export interface TrackerObservation {
  title: string;
  body: string;
  closed: boolean;
  comments: IssueComment[];
  complete: boolean;
  revision: string;
}
export interface Profile {
  harness: string;
  model: string;
  instructions: string;
  timeoutMs: number;
}
export interface IssuePolicy {
  hash: string;
  stage: string;
  timeoutMs: number | undefined;
  implement: boolean;
  publish: boolean;
  assumptions: boolean;
  followUps: boolean;
  profiles: Record<Role, Profile>;
  concurrency: number;
}
export interface IssueRecord {
  id: string;
  ref: IssueReference;
  root: string;
  ownerId: string;
  title: string;
  body: string;
  stage: IssueStage;
  waiting: Waiting;
  detail: string;
  epoch: number;
  brief: Brief | undefined;
  approvedVersion: number;
  publicationVersion: number;
  policyHash: string;
  externalClosed: boolean;
  comments: IssueComment[];
  reviewedComments: string[];
  pendingComments: IssueComment[];
  clarificationRound: number;
  clarificationDueAt: number | undefined;
  timeoutPlanned: boolean;
  prUrl: string;
  prHead: string;
  verifiedHead: string;
  assignmentId: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  nextAt: number;
  pollIntervalMs: number;
}
export interface Assignment {
  id: string;
  issueId: string;
  role: Role;
  purpose: "stage" | "comments" | "timeout";
  briefVersion: number;
  epoch: number;
  state: AttemptState;
  sessionId: string;
  turnId: string;
  workspace: string;
  profile: Profile;
  prompt: string;
  result: StageResult | undefined;
  createdAt: number;
  updatedAt: number;
  detail: string;
}
export interface IssueEvent {
  sequence: number;
  issueId: string;
  at: number;
  kind: string;
  detail: string;
}
export function result(value: unknown): StageResult {
  if (!Check(ResultSchema, value))
    throw new Error("Invalid issue stage result");
  return value;
}
export function validateBrief(brief: Brief): void {
  if (
    !Check(BriefSchema, brief) ||
    brief.outcome.trim().length === 0 ||
    brief.scope.trim().length === 0 ||
    brief.criteria.length === 0 ||
    brief.criteria.some((item) => item.trim().length === 0)
  )
    throw new Error("Outcome, scope and acceptance criteria are required");
}
export function terminal(stage: IssueStage): boolean {
  return stage === IssueStage.Done || stage === IssueStage.Cancelled;
}
export function roleFor(stage: IssueStage): Role {
  switch (stage) {
    case IssueStage.Investigation:
      return Role.Investigation;
    case IssueStage.InProgress:
    case IssueStage.Testing:
      return Role.Implementation;
    case IssueStage.Verification:
      return Role.Verification;
    case IssueStage.Ready:
    case IssueStage.InReview:
    case IssueStage.Done:
    case IssueStage.Cancelled:
      throw new Error("Stage does not dispatch an agent");
  }
}
export function clarificationTimeout(stage: string): number | undefined {
  switch (stage) {
    case "research":
    case "alpha":
      return 0;
    case "beta":
      return 3600000;
    case "production":
      return 14400000;
    default:
      return undefined;
  }
}
