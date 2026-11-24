import { AutomationPolicySchema } from "../repository/contracts.js";
import { Type } from "typebox";
import {
  ChainSchema,
  EntrySchema,
  OperationSchema,
  DependencySchema,
  ReferenceSchema,
  CommandSchema,
  QueueInputSchema,
  OperationState,
  EntryState,
} from "../merging/contracts.js";
import { DigestSchema, RevisionSchema } from "../notifications/types.js";
import { ReceiptTargetSchema } from "../merging/receipt-types.js";
import {
  SubmissionSchema,
  PolicySchema,
  PolicyAnalysisSchema,
  ChangeAnalysisSchema,
  WriterSchema,
  SubmissionState,
} from "../submissions/contracts.js";
const text = Type.String();
const integer = Type.Integer();
const object = (properties: Record<string, import("typebox").TSchema>) =>
  Type.Object(properties, { additionalProperties: false });
const literals = (...values: string[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const check = object({
  id: text,
  key: text,
  name: text,
  headSha: text,
  status: text,
  conclusion: text,
  at: integer,
  url: text,
  workflowRunId: Type.Optional(integer),
  workflowRunAttempt: Type.Optional(integer),
  suiteId: Type.Optional(integer),
  workflowId: Type.Optional(integer),
  runNumber: Type.Optional(integer),
  event: Type.Optional(text),
});
const review = object({
  id: text,
  author: text,
  headSha: text,
  state: text,
  at: integer,
  url: text,
  body: Type.Optional(text),
});
const feedback = object({
  source: literals("review", "inline", "conversation"),
  id: text,
  revision: text,
  author: text,
  body: text,
  url: text,
  headSha: Type.Optional(text),
  path: Type.Optional(text),
  line: Type.Optional(integer),
  reviewId: Type.Optional(text),
});
const observed = (item: import("typebox").TSchema) =>
  Type.Union([
    object({ state: Type.Literal("complete"), value: Type.Array(item) }),
    object({
      state: Type.Literal("partial"),
      value: Type.Array(item),
      reason: text,
    }),
    object({ state: Type.Literal("unavailable"), reason: text }),
  ]);
const progress = Type.Union([
  object({ state: Type.Literal("pending"), nextAttemptAt: integer }),
  object({ state: Type.Literal("sending"), startedAt: integer }),
  object({
    state: Type.Literal("delivered"),
    at: integer,
    turnId: Type.Optional(text),
    queueId: Type.Optional(text),
    note: Type.Optional(text),
  }),
  object({
    state: literals("uncertain", "unavailable", "cancelled"),
    at: integer,
    reason: text,
  }),
]);
const outcome = Type.Union([
  object({ state: Type.Literal("sending") }),
  object({
    state: Type.Literal("accepted"),
    at: integer,
    turnId: Type.Optional(text),
    queueId: Type.Optional(text),
  }),
  object({
    state: literals("rejected", "uncertain"),
    at: integer,
    reason: text,
  }),
]);
const receipt = object({ agentId: text, revision: integer, at: integer });
const eventDetail = object({
  reason: Type.Optional(text),
  queueId: Type.Optional(text),
  clientId: Type.Optional(text),
  dispatchId: Type.Optional(text),
  operation: Type.Optional(text),
  socket: Type.Optional(text),
  error: Type.Optional(text),
  state: Type.Optional(text),
  revision: Type.Optional(integer),
  receivedRevision: Type.Optional(integer),
  currentRevision: Type.Optional(integer),
  messages: Type.Optional(Type.Array(text)),
  deleted: Type.Optional(Type.Boolean()),
  historyComplete: Type.Optional(Type.Boolean()),
  oldRevision: Type.Optional(integer),
  nextRevision: Type.Optional(integer),
  omittedFields: Type.Optional(Type.Array(text)),
});
const event = object({
  sequence: integer,
  digestId: Type.Optional(text),
  agentId: text,
  at: integer,
  kind: text,
  detail: eventDetail,
});
// Archived raw worker output remains evidence even when it failed schema validation.
const stage = object({
  ...SubmissionSchema.properties.stages.items.properties,
  result: Type.Optional(
    Type.Union([PolicyAnalysisSchema, ChangeAnalysisSchema, WriterSchema]),
  ),
  invalidResult: Type.Optional(Type.Boolean()),
});
const archive = object({
  ...SubmissionSchema.properties,
  stages: Type.Array(stage),
});
export const roots = {
  CheckRecord: check,
  CheckEvidence: observed(check),
  ReviewEvidence: observed(review),
  FeedbackEvidence: observed(feedback),
  DeliveryProgress: progress,
  DeliveryOutcome: outcome,
  MergeChain: ChainSchema,
  MergeEntry: EntrySchema,
  RepositoryAutomationPolicy: AutomationPolicySchema,
  MergeOperation: OperationSchema,
  Dependency: DependencySchema,
  PRReference: ReferenceSchema,
  QueueInput: QueueInputSchema,
  ReceiptTarget: ReceiptTargetSchema,
  AgentDigest: DigestSchema,
  DigestRevision: RevisionSchema,
  DigestInspection: object({
    digest: DigestSchema,
    revision: RevisionSchema,
    revisions: Type.Array(integer),
    receipts: Type.Array(receipt),
    events: Type.Array(event),
  }),
  DigestReceipt: object({
    id: text,
    revision: integer,
    currentRevision: integer,
    agentId: text,
    receivedAtMs: integer,
  }),
  MergeReceiptResult: object({
    receipt: text,
    state: literals(...new Set(["queued", ...Object.values(EntryState)])),
    pr: Type.Optional(text),
    reason: Type.Optional(text),
    entry: Type.Optional(text),
    chain: Type.Optional(text),
    detail: Type.Optional(text),
  }),
  MergeOverview: object({
    chains: Type.Array(ChainSchema),
    entries: Type.Array(EntrySchema),
    operations: Type.Array(OperationSchema),
    dependencies: Type.Array(DependencySchema),
  }),
  ReconciliationResult: object({
    id: text,
    state: Type.Enum(OperationState),
    detail: text,
  }),
  ArchivedSubmissionSummary: object({
    id: text,
    state: Type.Enum(SubmissionState),
    detail: text,
    url: Type.Optional(text),
  }),
  ArchivedSubmission: archive,
  RepositoryPolicy: PolicySchema,
};
export { CommandSchema };

// Wire documentation lives beside the domain roots so generation cannot silently omit a capability.
export const rootDescriptions = {
  CheckRecord: "records one check execution at an observed PR revision.",
  CheckEvidence:
    "distinguishes complete, partial, and unavailable check observations.",
  ReviewEvidence:
    "distinguishes complete, partial, and unavailable review observations.",
  FeedbackEvidence:
    "retains review feedback together with the completeness of its observation.",
  DeliveryProgress:
    "records the delivery transport step without claiming that the agent received it.",
  DeliveryOutcome: "records confirmed, failed, or uncertain delivery evidence.",
  MergeChain: "groups ordered PR merge intents under one actor and lifecycle.",
  MergeEntry:
    "records the gates and exact-head readiness for one PR in a merge chain.",
  RepositoryAutomationPolicy:
    "records effective repository automation defaults and their provenance.",
  MergeOperation: "journals a GitHub mutation and its reconciliation evidence.",
  Dependency:
    "records an explicitly confirmed prerequisite between tracked PRs.",
  PRReference:
    "retains a discovered PR reference separately from a confirmed dependency.",
  QueueInput:
    "describes the ordered merge intents and request identity supplied by a caller.",
  ReceiptTarget:
    "freezes the PR, owner, and revision context associated with a notification.",
  AgentDigest: "identifies a recipient's evolving notification digest.",
  DigestRevision:
    "freezes one rendered notification revision and its exact members.",
  DigestInspection:
    "combines a digest revision with its receipts and retained delivery history.",
  DigestReceipt:
    "records receipt of a particular digest revision without accepting its actions.",
  MergeReceiptResult:
    "reports whether a receipt-bound merge was queued or blocked.",
  MergeOverview:
    "combines merge chains, entries, operations, and confirmed dependencies.",
  ReconciliationResult:
    "reports the observed outcome of reconciling an uncertain merge operation.",
  ArchivedSubmissionSummary:
    "summarizes a historical submission without loading its worker evidence.",
  ArchivedSubmission:
    "retains historical submission stages, including invalid worker output as evidence.",
  RepositoryPolicy:
    "records a versioned repository publication policy and its source evidence.",
} satisfies Record<keyof typeof roots, string>;
