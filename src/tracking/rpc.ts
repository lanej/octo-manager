import { actionNotice, noticeLabel } from "../security/notifications.js";
import { wire } from "../api/codec.js";
import {
  DomainCheckRecordSchema,
  DomainCheckEvidenceSchema,
  DomainReviewEvidenceSchema,
  DomainFeedbackEvidenceSchema,
  DomainDeliveryProgressSchema,
  DomainDeliveryOutcomeSchema,
} from "../gen/octomanager/v2/domain_pb.js";
import { TrackingState } from "./retirement.js";
import { TrackingState as WireTrackingState } from "../gen/octomanager/v2/tracking_pb.js";
import { CheckWatchState, type CheckWatch } from "./checks.js";
import type { AgentMessage } from "./inbox.js";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  AgentReferenceSchema,
  CheckWatchState as WireCheckWatchState,
  TrackedPullRequestSchema,
  PendingActionSchema,
  ActionDeliverySchema,
  TrackingSnapshotSchema,
  ActionState as WireActionState,
  DeliveryState as WireDeliveryState,
} from "../gen/octomanager/v2/tracking_pb.js";
import {
  ActionState,
  DeliveryState,
  type AgentRef,
  type Action,
  type Delivery,
  type TrackedPR,
} from "./types.js";
import type { TrackingService } from "./service.js";
export const actionStates: Record<ActionState, WireActionState> = {
  open: WireActionState.OPEN,
  acknowledged: WireActionState.ACKNOWLEDGED,
  working: WireActionState.WORKING,
  resolved: WireActionState.RESOLVED,
  superseded: WireActionState.SUPERSEDED,
};
const trackingStates: Record<TrackingState, WireTrackingState> = {
  watching: WireTrackingState.WATCHING,
  draining: WireTrackingState.DRAINING,
  archived: WireTrackingState.ARCHIVED,
  disabled: WireTrackingState.DISABLED,
};
const checkWatchStates: Record<CheckWatchState, WireCheckWatchState> = {
  waiting: WireCheckWatchState.WAITING,
  completed: WireCheckWatchState.COMPLETED,
  superseded: WireCheckWatchState.SUPERSEDED,
  cancelled: WireCheckWatchState.CANCELLED,
  expired: WireCheckWatchState.EXPIRED,
};
export function wireCheckWatch(watch: CheckWatch) {
  return {
    ...watch,
    state: checkWatchStates[watch.state],
    evidence: wire(DomainCheckEvidenceSchema, watch.evidence),
    createdAtMs: BigInt(watch.createdAt),
    updatedAtMs: BigInt(watch.updatedAt),
  };
}
const deliveryStates: Record<DeliveryState, WireDeliveryState> = {
  pending: WireDeliveryState.PENDING,
  sending: WireDeliveryState.SENDING,
  delivered: WireDeliveryState.DELIVERED,
  uncertain: WireDeliveryState.UNCERTAIN,
  unavailable: WireDeliveryState.UNAVAILABLE,
  cancelled: WireDeliveryState.CANCELLED,
};
export function wirePR(p: TrackedPR) {
  return create(TrackedPullRequestSchema, {
    id: p.id,
    url: p.url,
    originAgentId: p.originAgentId,
    ownerAgentId: p.ownerAgentId,
    enabled: p.enabled,
    trackingState: trackingStates[p.state],
    drainDeadlineAtMs:
      p.drainDeadlineAt === undefined ? undefined : BigInt(p.drainDeadlineAt),
    archivedAtMs: p.archivedAt === undefined ? undefined : BigInt(p.archivedAt),
    archiveReason: p.archiveReason,
    createdAtMs: BigInt(p.createdAt),
    updatedAtMs: BigInt(p.updatedAt),
    refreshError: p.lastRefreshError?.message,
    refreshErrorAtMs: p.lastRefreshError
      ? BigInt(p.lastRefreshError.at)
      : undefined,
    observation: p.observation
      ? {
          id: BigInt(p.observation.id),
          observedAtMs: BigInt(p.observation.observedAt),
          headSha: p.observation.headSha,
          baseSha: p.observation.baseSha,
          targetBase: p.observation.targetBase,
          lifecycle: p.observation.lifecycle,
          mergeability: p.observation.mergeability,
          checks: wire(DomainCheckEvidenceSchema, p.observation.checks),
          reviews: wire(DomainReviewEvidenceSchema, p.observation.reviews),
          ...(p.observation.workflows === undefined
            ? {}
            : {
                workflows: wire(
                  DomainCheckEvidenceSchema,
                  p.observation.workflows,
                ),
              }),
          ...(p.observation.feedback === undefined
            ? {}
            : {
                feedback: wire(
                  DomainFeedbackEvidenceSchema,
                  p.observation.feedback,
                ),
              }),
        }
      : undefined,
  });
}
export function wireAction(a: Action, full = false) {
  const notice = actionNotice(a, "");
  if (!full)
    return create(PendingActionSchema, {
      notificationKind: notice.kind,
      evidenceHeadSha: notice.head ?? "",
      id: a.id,
      prId: a.prId,
      ownerAgentId: a.ownerAgentId,
      state: actionStates[a.progress.state],
      summary: noticeLabel(actionNotice(a, "")),
      createdAtMs: BigInt(a.createdAt),
      updatedAtMs: BigInt(a.updatedAt),
    });
  const b = a.blocker,
    p = a.progress;
  return create(PendingActionSchema, {
    id: a.id,
    prId: a.prId,
    openedObservationId: BigInt(a.openedObservationId),
    sourceKey: a.sourceKey,
    ownerAgentId: a.ownerAgentId,
    blocker:
      b.kind === "conflict"
        ? {
            case: "conflict",
            value: {
              headSha: b.headSha,
              baseSha: b.baseSha,
              baseRef: b.baseRef,
            },
          }
        : b.kind === "check_failed"
          ? {
              case: "checkFailed",
              value: {
                sourceId: b.sourceId,
                checkName: b.checkName,
                headSha: b.headSha,
                checkKey: b.checkKey,
              },
            }
          : b.kind === "check_results"
            ? {
                case: "checkResults",
                value: {
                  watchId: b.watchId,
                  headSha: b.headSha,
                  state: checkWatchStates[b.state],
                  checks: b.checks.map((check) =>
                    wire(DomainCheckRecordSchema, check),
                  ),
                  ...(b.replacementHeadSha === undefined
                    ? {}
                    : { replacementHeadSha: b.replacementHeadSha }),
                },
              }
            : b.kind === "review_feedback"
              ? { case: "reviewFeedback", value: b.feedback }
              : {
                  case: "changesRequested",
                  value: {
                    reviewId: b.reviewId,
                    reviewer: b.reviewer,
                    reviewedHeadSha: b.reviewedHeadSha,
                  },
                },
    summary: a.summary,
    evidenceUrl: a.evidenceUrl,
    profile: a.profile,
    state: actionStates[p.state],
    progressAtMs: "at" in p ? BigInt(p.at) : undefined,
    progressAgentId: "agentId" in p ? p.agentId : undefined,
    resolvedObservationId:
      p.state === ActionState.Resolved ? BigInt(p.observationId) : undefined,
    closeReason: "reason" in p ? p.reason : undefined,
    createdAtMs: BigInt(a.createdAt),
    updatedAtMs: BigInt(a.updatedAt),
  });
}
export function wireDelivery(d: Delivery, message?: AgentMessage) {
  return create(ActionDeliverySchema, {
    id: d.id,
    actionId: d.actionId,
    recipientAgentId: d.recipientAgentId,
    state: deliveryStates[d.progress.state],
    ...(message === undefined
      ? {}
      : { messageSequence: BigInt(message.sequence) }),
    ...(message?.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAtMs: BigInt(message.acknowledgedAt) }),
    progress: wire(DomainDeliveryProgressSchema, d.progress),
    createdAtMs: BigInt(d.createdAt),
    updatedAtMs: BigInt(d.updatedAt),
  });
}
export function wireAgent(agent: AgentRef) {
  return create(AgentReferenceSchema, {
    id: agent.id,
    target: {
      harness: agent.harness,
      endpoint: agent.endpoint,
      sessionId: agent.sessionId,
      ...(agent.label === undefined ? {} : { label: agent.label }),
    },
    ...(agent.lastObservedRuntime === undefined
      ? {}
      : {
          harnessVersion: agent.lastObservedRuntime.version,
          versionObservedAtMs: BigInt(agent.lastObservedRuntime.observedAt),
        }),
  });
}
export function wireTracking(service: TrackingService) {
  const s = service.store.snapshot();
  return create(TrackingSnapshotSchema, {
    prs: s.prs.map(wirePR),
    agents: s.agents.map(wireAgent),
    actions: s.actions.map((a) => wireAction(a, true)),
    deliveries: s.deliveries.map((delivery) =>
      wireDelivery(delivery, service.store.inbox.get(delivery.id)),
    ),
    checkWatches: s.checkWatches.map(wireCheckWatch),
    attempts: s.attempts.map((a) => ({
      deliveryId: a.deliveryId,
      number: a.number,
      startedAtMs: BigInt(a.startedAt),
      harnessVersion: a.harnessVersion,
      outcome: wire(DomainDeliveryOutcomeSchema, a.outcome),
    })),
  });
}
export async function trackingOperation<T>(
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    const message =
      error instanceof Error ? error.message : "Tracking operation failed";
    if (message.includes("not found"))
      throw new ConnectError(message, Code.NotFound);
    if (
      /another owner|another agent|closed|before starting|no longer|disabled|Only unavailable|Only failed or interrupted assessments/.test(
        message,
      )
    )
      throw new ConnectError(message, Code.FailedPrecondition);
    if (/Invalid|Unsupported|unsupported/.test(message))
      throw new ConnectError(message, Code.InvalidArgument);
    if (message.includes("stopping"))
      throw new ConnectError(message, Code.Unavailable);
    throw new ConnectError("Tracking operation failed", Code.Internal);
  }
}
