import { once } from "node:events";
import type { ServiceImpl } from "@connectrpc/connect";
import { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";
import type { Coordinator } from "../coordinator.js";
import { wireSnapshot } from "../api/snapshot.js";
import { wireDetails, wireRefresh } from "./projection.js";

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
