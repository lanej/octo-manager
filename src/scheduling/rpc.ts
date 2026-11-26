import { once } from "node:events";
import type { ServiceImpl } from "@connectrpc/connect";
import { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";
import type { ApplicationApi } from "../application/api.js";
import { wireSnapshot } from "../api/snapshot.js";
import { wireDetails, wireRefresh } from "./projection.js";

export function dashboardRoutes(
  application: Pick<ApplicationApi, "services" | "jobs" | "store">,
): Pick<ServiceImpl<typeof SchedulerService>, "watchDashboard"> {
  return {
    async *watchDashboard(request, context) {
      const release =
        request.reviews && request.url !== ""
          ? application.services.githubScheduler.interest(request.url)
          : () => {};
      try {
        while (!context.signal.aborted) {
          const view =
            request.reviews && request.url !== ""
              ? application.services.githubScheduler.reviewState(request.url)
              : undefined;
          const frame = {
            snapshot: wireSnapshot(application),
            pullRequest: wireDetails(view?.details),
            refresh: wireRefresh(
              request.reviews
                ? view?.schedule
                : application.store.schedules.get(
                    `tracking:${application.store.tracking.prs().find((pr) => pr.url === request.url)?.id ?? ""}`,
                  ),
            ),
          };
          const tick = once(application.services.githubScheduler, "tick", {
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
