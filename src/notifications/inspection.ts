import { create } from "@bufbuild/protobuf";
import {
  NotificationItemSchema,
  NotificationIssueItemSchema,
  NotificationMessageSchema,
  NotificationUnavailableReason,
} from "../gen/octomanager/v2/notifications_pb.js";
import {
  DomainMergeEntrySchema,
  DomainMergeEntryState,
  DomainArchivedSubmissionSchema,
  DomainArchivedSubmissionState,
  DomainPRReferenceSchema,
  DomainReceiptTargetSchema,
} from "../gen/octomanager/v2/domain_pb.js";
import { wire } from "../api/codec.js";
import { archiveSubmission } from "../api/projections.js";
import type { EntryState } from "../merging/contracts.js";
import type { SubmissionState } from "../submissions/contracts.js";
import { GetActionResponseSchema } from "../gen/octomanager/v2/tracking_pb.js";
import { wireAction } from "../tracking/rpc.js";
import { wireAssessment } from "../assessments/rpc.js";
import { wireIssueEvidence, wireIssueNotificationKind } from "../issues/subscription-wire.js";
import { wireIssue } from "../issues/rpc.js";
import { noticeLabel } from "../security/notifications.js";
import type { Store } from "../coordinator/store.js";
import type { DigestRevision } from "./types.js";
import type { AgentMessage, NotificationSource } from "./message.js";

const mergeStates: Record<EntryState, DomainMergeEntryState> = {
  waiting: DomainMergeEntryState.WAITING,
  preparing: DomainMergeEntryState.PREPARING,
  waiting_owner: DomainMergeEntryState.WAITING_OWNER,
  waiting_checks: DomainMergeEntryState.WAITING_CHECKS,
  ready: DomainMergeEntryState.READY,
  merging: DomainMergeEntryState.MERGING,
  merged: DomainMergeEntryState.MERGED,
  blocked: DomainMergeEntryState.BLOCKED,
  uncertain: DomainMergeEntryState.UNCERTAIN,
  cancelled: DomainMergeEntryState.CANCELLED,
};
const submissionStates: Record<SubmissionState, DomainArchivedSubmissionState> = {
  queued: DomainArchivedSubmissionState.QUEUED,
  analyzing: DomainArchivedSubmissionState.ANALYZING,
  writing: DomainArchivedSubmissionState.WRITING,
  publishing: DomainArchivedSubmissionState.PUBLISHING,
  enrolling: DomainArchivedSubmissionState.ENROLLING,
  succeeded: DomainArchivedSubmissionState.SUCCEEDED,
  needs_input: DomainArchivedSubmissionState.NEEDS_INPUT,
  failed: DomainArchivedSubmissionState.FAILED,
  uncertain: DomainArchivedSubmissionState.UNCERTAIN,
  cancelled: DomainArchivedSubmissionState.CANCELLED,
};

function lookup<T extends { id: string }>(read: () => T[]) {
  let values: Map<string, T> | undefined;
  return (id: string) => {
    values ??= new Map(read().map((value) => [value.id, value]));
    return values.get(id);
  };
}

export type MessageSnapshot = Pick<DigestRevision, "dispatchId" | "body" | "messageIds" | "createdAt" | "mergeTarget">;
type Sources = Pick<Store, "tracking" | "assessments" | "merging" | "issues" | "submissions">;

export function inspectMessage(
  store: Sources,
  snapshot: MessageSnapshot,
  recipient: string,
  full: boolean,
  applicable: (message: AgentMessage) => boolean,
) {
  const action = lookup(() => store.tracking.actions());
  const entry = lookup(() => store.merging.entries());
  const issue = lookup(() => store.issues.list());
  const submission = lookup(() => store.submissions.list());
  const reference = lookup(() => store.merging.refs());
  const items = snapshot.messageIds.map((id) => {
    const message = store.tracking.inbox.get(id);
    const current = message !== undefined && applicable(message);
    const summary = !message?.notice ? "Historical notification" : noticeLabel(message.notice);
    const item = create(NotificationItemSchema, {
      id,
      applicable: current,
      ...(message?.acknowledgedAt === undefined ? {} : { acknowledgedAtMs: BigInt(message.acknowledgedAt) }),
      summary: current ? summary : `Stale · ${summary}`,
      ...(full && message ? { untrustedBody: message.body } : {}),
    });
    if (message && message.recipientAgentId !== recipient)
      throw new Error("Frozen member belongs to another recipient");
    const source: NotificationSource = message?.source ?? {
      kind: "unavailable",
    };
    function unavailable(sourceId: string, reason = NotificationUnavailableReason.MISSING_SOURCE) {
      item.source = {
        case: "unavailable",
        value: {
          $typeName: "octomanager.v2.NotificationUnavailableItem",
          sourceId,
          reason,
        },
      };
      return item;
    }
    switch (source.kind) {
      case "action": {
        const value = action(source.id);
        if (!value) return unavailable(source.id);
        const assessmentId = message?.notice?.assessmentId;
        const assessment = assessmentId === undefined ? undefined : store.assessments.get(assessmentId);
        item.source = {
          case: "action",
          value: create(GetActionResponseSchema, {
            action: wireAction(value, full),
            ...(!assessment ? {} : { assessment: wireAssessment(assessment, full) }),
          }),
        };
        return item;
      }
      case "merge": {
        const value = entry(source.id);
        if (!value) return unavailable(source.id);
        item.source = {
          case: "merge",
          value: {
            $typeName: "octomanager.v2.NotificationMergeItem",
            entryId: value.id,
            chainId: value.chainId,
            state: mergeStates[value.state],
            ...(full ? { detail: wire(DomainMergeEntrySchema, value) } : {}),
          },
        };
        return item;
      }
      case "issue": {
        const value = issue(source.id);
        if (!value) return unavailable(source.id);
        const projected = wireIssue(value);
        item.source = {
          case: "issue",
          value: create(NotificationIssueItemSchema, {
            issueId: value.id,
            ...(message?.notice?.issueEventId === undefined ? {} : { eventId: message.notice.issueEventId }),
            ...(message?.notice?.issueEventKind === undefined
              ? {}
              : {
                  eventKind: wireIssueNotificationKind(message.notice.issueEventKind),
                }),
            ...(full && message?.notice?.issueEventId !== undefined
              ? (() => {
                  const evidence = store.issues.subscriptions.evidence(message.notice.issueEventId);
                  return !evidence ? {} : { evidence: wireIssueEvidence(evidence) };
                })()
              : {}),
            stage: projected.stage,
            waiting: projected.waiting,
            ...(full ? { detail: projected } : {}),
          }),
        };
        return item;
      }
      case "submission": {
        const value = submission(source.id);
        if (!value) return unavailable(source.id);
        item.source = {
          case: "submission",
          value: {
            $typeName: "octomanager.v2.NotificationSubmissionItem",
            submissionId: value.id,
            state: submissionStates[value.state],
            ...(full
              ? {
                  detail: wire(DomainArchivedSubmissionSchema, archiveSubmission(value)),
                }
              : {}),
          },
        };
        return item;
      }
      case "participants": {
        const value = store.tracking.prs().find((value) => value.id === source.id);
        if (!value) return unavailable(source.id);
        const participants = store.tracking.participants(value.id);
        item.source = {
          case: "participants",
          value: {
            $typeName: "octomanager.v2.NotificationParticipantsItem",
            prId: value.id,
            count: participants.length,
            detail: full
              ? participants.map((value) => ({
                  $typeName: "octomanager.v2.PRParticipant",
                  ...value,
                }))
              : [],
          },
        };
        return item;
      }
      case "reference": {
        const value = reference(source.id);
        if (!value) return unavailable(source.id);
        item.source = {
          case: "reference",
          value: {
            $typeName: "octomanager.v2.NotificationReferenceItem",
            referenceId: value.id,
            ...(full ? { detail: wire(DomainPRReferenceSchema, value) } : {}),
          },
        };
        return item;
      }
      case "unavailable":
        return unavailable(
          id,
          !message ? NotificationUnavailableReason.MISSING_SOURCE : NotificationUnavailableReason.UNKNOWN_SOURCE,
        );
    }
  });
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.summary, (counts.get(item.summary) ?? 0) + 1);
  const summary = [...counts]
    .map(([label, count]) => (count === 1 ? label : `${label} (${String(count)})`))
    .join(" · ");
  return create(NotificationMessageSchema, {
    id: snapshot.dispatchId,
    recipientAgentId: recipient,
    summary,
    items,
    createdAtMs: BigInt(snapshot.createdAt),
    ...(full ? { untrustedBody: snapshot.body } : {}),
    ...(full && snapshot.mergeTarget ? { mergeTarget: wire(DomainReceiptTargetSchema, snapshot.mergeTarget) } : {}),
  });
}
