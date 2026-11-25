import { EntryState } from "../merging/contracts.js";
import { IssueNotificationKind } from "../issues/contracts.js";
import { IssueStage, Waiting } from "../issues/contracts.js";
import { shortId } from "../tracking/identifiers.js";
import type { Action } from "../tracking/types.js";
import { successfulCheck } from "../tracking/checks.js";
import { canonicalPR } from "../github/pr-identity.js";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const NoticeSubjectKind = {
  Submission: "submission",
  MergeEntry: "merge_entry",
  Reference: "reference",
  Issue: "issue",
  Action: "action",
} as const;

export const NoticeSchema = Type.Object(
  {
    version: Type.Literal(1),
    references: Type.Optional(
      Type.Object(
        {
          message: Type.String(),
          action: Type.String(),
          assessment: Type.Optional(Type.String()),
          subject: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    kind: Type.Union([
      Type.Literal("conflict"),
      Type.Literal("check_failed"),
      Type.Literal("changes_requested"),
      Type.Literal("review_feedback"),
      Type.Literal("checks_passed"),
      Type.Literal("checks_completed"),
      Type.Literal("participants"),
      Type.Literal("submission"),
      Type.Literal("merge"),
      Type.Literal("update"),
      Type.Literal("issue"),
    ]),
    prUrl: Type.Optional(Type.String()),
    head: Type.Optional(Type.String()),
    mergeState: Type.Optional(Type.Enum(EntryState)),
    mergeOrigin: Type.Optional(
      Type.Union([Type.Literal("external"), Type.Literal("octo")]),
    ),
    issueStage: Type.Optional(Type.Enum(IssueStage)),
    issueWaiting: Type.Optional(Type.Enum(Waiting)),
    issueRevision: Type.Optional(Type.String()),
    issueEventKind: Type.Optional(Type.Enum(IssueNotificationKind)),
    issueEventId: Type.Optional(Type.String()),
    assessmentId: Type.Optional(Type.String()),
    subject: Type.Optional(
      Type.Object(
        {
          kind: Type.Enum(NoticeSubjectKind),
          id: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    role: Type.Optional(
      Type.Union([Type.Literal("owner"), Type.Literal("observer")]),
    ),
    assessment: Type.Union([
      Type.Literal("pending"),
      Type.Literal("completed"),
      Type.Literal("unavailable"),
      Type.Literal("not_required"),
    ]),
  },
  { additionalProperties: false },
);
export type SafeNotice = Static<typeof NoticeSchema>;
const labels: Record<SafeNotice["kind"], string> = {
  conflict: "Merge conflict",
  check_failed: "Checks failed",
  changes_requested: "Changes requested",
  review_feedback: "Review feedback",
  checks_passed: "Checks passed",
  checks_completed: "Checks completed",
  participants: "Participants changed",
  submission: "Submission update",
  merge: "Merge workflow update",
  update: "Octo update",
  issue: "Issue update",
};
export function noticeLabel(notice: SafeNotice): string {
  return notice.issueEventKind === undefined
    ? labels[notice.kind]
    : `Issue ${notice.issueEventKind.replaceAll("_", " ")}`;
}
export function parseNotice(value: unknown): SafeNotice {
  if (!Check(NoticeSchema, value)) throw new Error("Invalid safe notification");
  return value;
}
export function validPR(value: string): string | undefined {
  try {
    const url = canonicalPR(value);
    return url === value ? url : undefined;
  } catch {
    return undefined;
  }
}
export function actionNotice(
  action: Action,
  prUrl: string,
  assessment?: SafeNotice["assessment"],
): SafeNotice {
  const b = action.blocker;
  const kind =
    b.kind === "check_results"
      ? b.checks.every((check) => check.conclusion === "success")
        ? "checks_passed"
        : b.checks.some((check) => !successfulCheck(check))
          ? "check_failed"
          : "checks_completed"
      : b.kind;
  const revision =
    b.kind === "changes_requested"
      ? b.reviewedHeadSha
      : b.kind === "review_feedback"
        ? b.feedback.headSha
        : b.headSha;
  const url = validPR(prUrl);
  return {
    version: 1,
    kind,
    assessment:
      assessment ??
      (b.kind === "review_feedback" ||
      b.kind === "check_failed" ||
      (b.kind === "check_results" && b.checks.some((c) => !successfulCheck(c)))
        ? "pending"
        : "not_required"),
    ...(url === undefined ? {} : { prUrl: url }),
    ...(/^[a-f0-9]{40,64}$/u.test(revision ?? "") ? { head: revision } : {}),
  };
}

export interface NoticeReference {
  label: string;
  url?: string;
}
export interface NoticeField {
  label:
    | "Assessment"
    | "Role"
    | "Assessment record"
    | "Submission"
    | "Merge entry"
    | "Reference"
    | "Action"
    | "Issue"
    | "Issue stage"
    | "Waiting";
  value: string;
}
export interface NoticeView {
  group: NoticeReference;
  reference: NoticeReference;
  title: string;
  fields: NoticeField[];
}
export function noticeView(
  notice: SafeNotice,
  actionId: string,
  identities?: { actions: string[]; messages: string[] },
): NoticeView {
  const url = notice.prUrl === undefined ? undefined : validPR(notice.prUrl);
  const group: NoticeReference =
    url === undefined
      ? { label: "Octo" }
      : { label: `PR #${new URL(url).pathname.split("/").at(-1) ?? ""}`, url };
  const head =
    notice.head !== undefined && /^[a-f0-9]{40,64}$/u.test(notice.head)
      ? notice.head
      : undefined;
  const reference =
    url !== undefined && head !== undefined
      ? {
          label: `${group.label} @ ${head.slice(0, 8)}`,
          url: `${url}/commits/${head}`,
        }
      : group;
  const id = (value: string, ids: string[]) =>
    /^[a-f0-9-]{8,36}$/u.test(value) ? shortId(value, ids) : "unavailable";
  const fields: NoticeField[] = [
    { label: "Assessment", value: notice.assessment },
  ];
  if (notice.issueStage !== undefined)
    fields.push({ label: "Issue stage", value: notice.issueStage });
  if (notice.issueWaiting !== undefined && notice.issueWaiting !== Waiting.None)
    fields.push({ label: "Waiting", value: notice.issueWaiting });
  if (notice.role !== undefined)
    fields.push({ label: "Role", value: notice.role });
  if (notice.assessmentId !== undefined)
    fields.push({
      label: "Assessment record",
      value: notice.references?.assessment ?? id(notice.assessmentId, []),
    });
  if (notice.subject !== undefined && notice.subject.kind !== "action")
    fields.push({
      label:
        notice.subject.kind === "issue"
          ? "Issue"
          : notice.subject.kind === "submission"
            ? "Submission"
            : notice.subject.kind === "merge_entry"
              ? "Merge entry"
              : "Reference",
      value: notice.references?.subject ?? id(notice.subject.id, []),
    });
  fields.push({
    label: "Action",
    value:
      notice.subject?.kind === "action"
        ? (notice.references?.subject ??
          id(notice.subject.id, identities?.actions ?? []))
        : actionId === ""
          ? "none"
          : (notice.references?.action ??
            id(actionId, identities?.actions ?? [])),
  });
  return {
    group,
    reference,
    title:
      notice.mergeState === EntryState.Merged
        ? notice.mergeOrigin === "external"
          ? "External merge observed · workflow reconciled"
          : notice.mergeOrigin === "octo"
            ? "GitHub confirmed merge · Octo execution"
            : "GitHub confirmed merge"
        : noticeLabel(notice),
    fields,
  };
}
export function renderReference(reference: NoticeReference): string {
  return reference.url === undefined
    ? reference.label
    : `[${reference.label}](${reference.url})`;
}
export function renderNotice(
  notice: SafeNotice,
  messageId: string,
  actionId: string,
  identities?: { actions: string[]; messages: string[] },
): string {
  const view = noticeView(notice, actionId, identities);
  const id =
    notice.references?.message ??
    (/^[a-f0-9-]{8,36}$/u.test(messageId)
      ? shortId(messageId, identities?.messages ?? [])
      : "unavailable");
  return [
    `[octo-delivery:${id}]`,
    "[octo-notice:v1]",
    `${renderReference(view.reference)} · ${view.title}`,
    ...view.fields.map((field) => `${field.label}: ${field.value}`),
  ].join("\n");
}
