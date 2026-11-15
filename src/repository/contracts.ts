import { Type, type Static } from "typebox";
export enum NotificationState {
  ReviewFeedback = "review_feedback",
  ChecksFailed = "checks_failed",
  MergeConflict = "merge_conflict",
  DependenciesPending = "dependencies_pending",
  OwnerReviewRequired = "owner_review_required",
  Ready = "ready",
  Merged = "merged",
  MergeUncertain = "merge_uncertain",
  MergeBlocked = "merge_blocked",
}
export const stages = ["research", "alpha", "beta", "production"] as const;
export const StageSchema = Type.Union([
  Type.Literal("research"),
  Type.Literal("alpha"),
  Type.Literal("beta"),
  Type.Literal("production"),
]);
const text = Type.String({ maxLength: 1000 });
export const InstructionsSchema = Type.Object(
  {
    review_feedback: Type.Optional(text),
    checks_failed: Type.Optional(text),
    merge_conflict: Type.Optional(text),
    dependencies_pending: Type.Optional(text),
    owner_review_required: Type.Optional(text),
    ready: Type.Optional(text),
    merged: Type.Optional(text),
    merge_uncertain: Type.Optional(text),
    merge_blocked: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const ConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    merging: Type.Optional(
      Type.Object(
        {
          auto_merge: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("project_stage")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    notifications: Type.Optional(
      Type.Object(
        { instructions: Type.Optional(InstructionsSchema) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const AutomationPolicySchema = Type.Object(
  {
    prId: Type.String(),
    root: Type.String(),
    ownerId: Type.String(),
    epoch: Type.Integer(),
    status: Type.Union([
      Type.Literal("valid"),
      Type.Literal("missing"),
      Type.Literal("invalid"),
    ]),
    hash: Type.String(),
    stage: Type.Optional(StageSchema),
    autoMerge: Type.Boolean(),
    instructions: InstructionsSchema,
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type AutomationPolicy = Static<typeof AutomationPolicySchema>;
export type Instructions = Static<typeof InstructionsSchema>;
export const defaults: Record<NotificationState, string> = {
  review_feedback:
    "Inspect and address actionable review findings using the installed project guidance.",
  checks_failed:
    "Inspect the failed run and address the cause using the installed project checks.",
  merge_conflict:
    "Inspect and resolve the merge conflict using the installed project guidance.",
  dependencies_pending: "Inspect and report the remaining prerequisites.",
  owner_review_required:
    "Review the current head and record readiness when satisfied.",
  ready:
    "Review the current head and proceed with the requested merge workflow.",
  merged: "Report completion and perform the configured post-merge follow-up.",
  merge_uncertain: "Inspect reconciliation evidence before retrying the merge.",
  merge_blocked: "Inspect and address the reported merge blocker.",
};
