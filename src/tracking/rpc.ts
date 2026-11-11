import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  AgentReferenceSchema,
  TrackedPullRequestSchema,
  PendingActionSchema,
  ActionDeliverySchema,
  TrackingSnapshotSchema,
  ActionState as WireActionState,
  DeliveryState as WireDeliveryState,
} from "../gen/octomanager/v1/tracking_pb.js";
import {
  ActionState,
  DeliveryState,
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
          checksJson: JSON.stringify(p.observation.checks),
          reviewsJson: JSON.stringify(p.observation.reviews),
          ...(p.observation.feedback === undefined
            ? {}
            : { feedbackJson: JSON.stringify(p.observation.feedback) }),
        }
      : undefined,
  });
}
export function wireAction(a: Action) {
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
export function wireDelivery(d: Delivery) {
  return create(ActionDeliverySchema, {
    id: d.id,
    actionId: d.actionId,
    recipientAgentId: d.recipientAgentId,
    state: deliveryStates[d.progress.state],
    progressJson: JSON.stringify(d.progress),
    createdAtMs: BigInt(d.createdAt),
    updatedAtMs: BigInt(d.updatedAt),
  });
}
export function wireTracking(service: TrackingService) {
  const s = service.store.snapshot();
  return create(TrackingSnapshotSchema, {
    prs: s.prs.map(wirePR),
    agents: s.agents.map((a) =>
      create(AgentReferenceSchema, {
        id: a.id,
        target: {
          harness: a.harness,
          endpoint: a.endpoint,
          sessionId: a.sessionId,
          label: a.label,
        },
        harnessVersion: a.lastObservedRuntime?.version,
        versionObservedAtMs: a.lastObservedRuntime
          ? BigInt(a.lastObservedRuntime.observedAt)
          : undefined,
      }),
    ),
    actions: s.actions.map(wireAction),
    deliveries: s.deliveries.map(wireDelivery),
    attempts: s.attempts.map((a) => ({
      deliveryId: a.deliveryId,
      number: a.number,
      startedAtMs: BigInt(a.startedAt),
      harnessVersion: a.harnessVersion,
      outcomeJson: JSON.stringify(a.outcome),
    })),
  });
}
export async function trackingOperation<T>(
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Tracking operation failed";
    if (message.includes("not found"))
      throw new ConnectError(message, Code.NotFound);
    if (
      /another owner|another agent|closed|before starting|no longer|disabled|Only unavailable/.test(
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
