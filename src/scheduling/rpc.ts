import { RefreshState } from "../gen/octomanager/v1/github_pb.js";
import { once } from "node:events";
import type { ServiceImpl } from "@connectrpc/connect";
import { SchedulerService } from "../gen/octomanager/v1/scheduler_pb.js";
import type { Coordinator } from "../coordinator.js";
import type { PullRequestDetails } from "../github.js";
import { wireSnapshot } from "../rpc.js";
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
    lastAttemptAtMs:
      value.lastAttemptAtMs === undefined
        ? undefined
        : BigInt(value.lastAttemptAtMs),
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
export function dashboardRoutes(
  coordinator: Coordinator,
): Pick<ServiceImpl<typeof SchedulerService>, "watchDashboard"> {
  return {
    async *watchDashboard(request, context) {
      const release =
        request.reviews && request.url !== ""
          ? coordinator.githubScheduler.interest(request.url)
          : () => {};
      try {
        while (!context.signal.aborted) {
          const view =
            request.reviews && request.url !== ""
              ? coordinator.githubScheduler.reviewState(request.url)
              : undefined;
          const frame = {
            snapshot: wireSnapshot(coordinator),
            pullRequest: wireDetails(view?.details),
            refresh: wireRefresh(
              request.reviews
                ? view?.schedule
                : coordinator.store.schedules.get(
                    `tracking:${coordinator.store.tracking.prs().find((pr) => pr.url === request.url)?.id ?? ""}`,
                  ),
            ),
          };
          const tick = once(coordinator.githubScheduler, "tick", {
            signal: context.signal,
          }).catch(() => []);
          yield frame;
          await tick;
        }
      } finally {
        release();
      }
    },
  };
}
