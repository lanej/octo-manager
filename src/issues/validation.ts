import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  BriefSchema,
  CommentSchema,
  ReferenceSchema,
  ResultSchema,
  IssueStage,
  Waiting,
  Role,
  AttemptState,
  type IssueRecord,
  type Assignment,
  type Brief,
} from "./contracts.js";
const text = Type.String();
const number = Type.Integer({ minimum: 0 });
const profile = Type.Object({
  harness: text,
  model: text,
  instructions: text,
  timeoutMs: number,
});
const issue = Type.Object({
  id: text,
  ref: ReferenceSchema,
  root: text,
  ownerId: text,
  title: text,
  body: text,
  stage: Type.Enum(IssueStage),
  waiting: Type.Enum(Waiting),
  detail: text,
  epoch: number,
  brief: Type.Optional(BriefSchema),
  approvedVersion: number,
  publicationVersion: number,
  policyHash: text,
  externalClosed: Type.Boolean(),
  comments: Type.Array(CommentSchema),
  reviewedComments: Type.Array(text),
  pendingComments: Type.Array(CommentSchema),
  clarificationRound: number,
  clarificationDueAt: Type.Optional(number),
  timeoutPlanned: Type.Boolean(),
  prUrl: text,
  prHead: text,
  verifiedHead: text,
  assignmentId: text,
  workspace: text,
  createdAt: number,
  updatedAt: number,
  nextAt: number,
  pollIntervalMs: number,
});
const assignment = Type.Object({
  id: text,
  issueId: text,
  role: Type.Enum(Role),
  purpose: Type.Union([
    Type.Literal("stage"),
    Type.Literal("comments"),
    Type.Literal("timeout"),
  ]),
  briefVersion: number,
  epoch: number,
  state: Type.Enum(AttemptState),
  sessionId: text,
  turnId: text,
  workspace: text,
  profile,
  prompt: text,
  result: Type.Optional(ResultSchema),
  createdAt: number,
  updatedAt: number,
  detail: text,
});
function stored(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Invalid stored issue record");
  const parsed: unknown = JSON.parse(value);
  return parsed;
}
function isIssue(value: unknown): value is IssueRecord {
  return Check(issue, value);
}
function isAssignment(value: unknown): value is Assignment {
  return Check(assignment, value);
}
export function decodeIssue(value: unknown): IssueRecord {
  const parsed = stored(value);
  if (!isIssue(parsed)) throw new Error("Stored issue failed validation");
  return parsed;
}
export function decodeAssignment(value: unknown): Assignment {
  const parsed = stored(value);
  if (!isAssignment(parsed))
    throw new Error("Stored assignment failed validation");
  return parsed;
}

export function decodeIssueBrief(value: unknown): Brief {
  const parsed = stored(value);
  if (!Check(BriefSchema, parsed))
    throw new Error("Stored brief failed validation");
  return parsed;
}
