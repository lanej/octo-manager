export type UnixMillis = number;
export interface AgentRef {
  id: string;
  harness: string;
  endpoint: string;
  sessionId: string;
  label?: string;
  lastObservedRuntime?: { version: string; observedAt: UnixMillis };
}
export interface AgentTarget {
  harness: string;
  endpoint: string;
  sessionId: string;
  label?: string;
}
export interface TrackedPR {
  id: string;
  url: string;
  originAgentId: string;
  ownerAgentId: string;
  enabled: boolean;
  createdAt: UnixMillis;
  updatedAt: UnixMillis;
  lastRefreshError?: { at: UnixMillis; message: string };
  observation?: PRObservation;
}
export type ObservationPart<T> =
  | { state: "complete"; value: T }
  | { state: "partial"; value: T; reason: string }
  | { state: "unavailable"; reason: string };
export interface CheckObservation {
  id: string;
  key: string;
  name: string;
  headSha: string;
  status: string;
  conclusion: string;
  at: number;
  url: string;
}
export interface ReviewObservation {
  id: string;
  author: string;
  headSha: string;
  state: string;
  at: number;
  url: string;
}
export interface TargetBase {
  ref: string;
  sha: string;
}
export interface ActionEventContext {
  state: ActionState;
  prUrl: string;
  actorAgentId?: string;
  actorHarness?: string;
  actorSessionId?: string;
  actorLabel?: string;
}
export interface PRObservation {
  id: number;
  prId: string;
  observedAt: UnixMillis;
  headSha: string;
  baseSha: string;
  targetBase?: TargetBase;
  lifecycle: "open" | "closed" | "merged";
  mergeability: "mergeable" | "conflicting" | "unknown";
  checks: ObservationPart<CheckObservation[]>;
  reviews: ObservationPart<ReviewObservation[]>;
}
export type ObservationInput = Omit<PRObservation, "id" | "prId">;
export enum ActionState {
  Open = "open",
  Acknowledged = "acknowledged",
  Working = "working",
  Resolved = "resolved",
  Superseded = "superseded",
}
export type Blocker =
  | { kind: "conflict"; headSha: string; baseSha: string; baseRef?: string }
  | {
      kind: "check_failed";
      sourceId: string;
      checkName: string;
      headSha: string;
      checkKey: string;
    }
  | {
      kind: "changes_requested";
      reviewId: string;
      reviewer: string;
      reviewedHeadSha: string;
    };
export interface ExecutionProfile {
  name: string;
  instructions: string;
  harness?: string;
  model?: string;
}
export type ActionProgress =
  | { state: ActionState.Open }
  | {
      state: ActionState.Acknowledged | ActionState.Working;
      at: number;
      agentId: string;
    }
  | {
      state: ActionState.Resolved;
      at: number;
      observationId: number;
      reason: string;
    }
  | { state: ActionState.Superseded; at: number; reason: string };
export interface Action {
  id: string;
  prId: string;
  openedObservationId: number;
  sourceKey: string;
  ownerAgentId: string;
  blocker: Blocker;
  summary: string;
  evidenceUrl: string;
  profile: ExecutionProfile;
  progress: ActionProgress;
  createdAt: number;
  updatedAt: number;
}
export enum DeliveryState {
  Pending = "pending",
  Sending = "sending",
  Delivered = "delivered",
  Uncertain = "uncertain",
  Unavailable = "unavailable",
  Cancelled = "cancelled",
}
export type DeliveryProgress =
  | { state: DeliveryState.Pending; nextAttemptAt: number }
  | { state: DeliveryState.Sending; startedAt: number }
  | {
      state: DeliveryState.Delivered;
      at: number;
      turnId?: string;
      queueId?: string;
      note?: string;
    }
  | {
      state:
        | DeliveryState.Uncertain
        | DeliveryState.Unavailable
        | DeliveryState.Cancelled;
      at: number;
      reason: string;
    };
export interface Delivery {
  retryCount?: number;
  id: string;
  actionId: string;
  recipientAgentId: string;
  progress: DeliveryProgress;
  createdAt: number;
  updatedAt: number;
}
export interface DeliveryAttempt {
  deliveryId: string;
  number: number;
  startedAt: number;
  harnessVersion?: string;
  outcome:
    | { state: "sending" }
    | { state: "accepted"; at: number; turnId?: string; queueId?: string }
    | { state: "rejected" | "uncertain"; at: number; reason: string };
}
export interface TrackingSnapshot {
  prs: TrackedPR[];
  agents: AgentRef[];
  actions: Action[];
  deliveries: Delivery[];
  attempts: DeliveryAttempt[];
}
export const unfinished = (a: Action): boolean =>
  [ActionState.Open, ActionState.Acknowledged, ActionState.Working].includes(
    a.progress.state,
  );
