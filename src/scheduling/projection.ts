import { RefreshState } from "../gen/octomanager/v2/github_pb.js";
import type { PullRequestDetails } from "../github/reviews.js";
import { ScheduleState, type ScheduledRefresh } from "./contracts.js";
import type { GitHubScheduler } from "./service.js";

export function wireScheduler(service: GitHubScheduler) {
  const value = service.status();
  return {
    ...value,
    tickMs: BigInt(value.tickMs),
    requestSpacingMs: BigInt(value.requestSpacingMs),
    tickSequence: BigInt(value.tickSequence),
    nextTickAtMs: BigInt(value.nextTickAtMs),
    nextDispatchAtMs: BigInt(value.nextDispatchAtMs),
    coreRetryAtMs: BigInt(value.coreRetryAtMs),
    graphqlRetryAtMs: BigInt(value.graphqlRetryAtMs),
  };
}
const states: Record<ScheduleState, RefreshState> = {
  [ScheduleState.Queued]: RefreshState.QUEUED,
  [ScheduleState.Running]: RefreshState.RUNNING,
  [ScheduleState.Deferred]: RefreshState.DEFERRED,
};
export function wireRefresh(value: ScheduledRefresh | undefined) {
  if (value === undefined) return undefined;
  return {
    state: states[value.state],
    dueAtMs: BigInt(value.dueAtMs),
    lastAttemptAtMs: value.lastAttemptAtMs === undefined ? undefined : BigInt(value.lastAttemptAtMs),
    lastError: value.lastError ?? "",
  };
}
export function wireDetails(value: PullRequestDetails | undefined) {
  if (value === undefined) return undefined;
  return {
    ...value,
    observedAtMs: BigInt(value.observedAtMs),
    messages: value.messages.map((message) => ({
      ...message,
      atMs: BigInt(message.atMs),
      line: message.line === undefined ? undefined : BigInt(message.line),
    })),
  };
}
