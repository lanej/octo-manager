import type { ServiceImpl } from "@connectrpc/connect";
import { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";
import type { ApplicationApi } from "../application/api.js";
import { retainedDashboardSnapshot } from "../api/snapshot.js";
import { wireDetails, wireRefresh } from "./projection.js";

export function dashboardRoutes(
  application: Pick<ApplicationApi, "services" | "jobs" | "store">,
): Pick<ServiceImpl<typeof SchedulerService>, "watchDashboard"> {
  const snapshots = retainedDashboardSnapshot(application);
  let subscribers = 0;
  let releaseEvents: (() => void) | undefined;
  const invalidate = () => {
    snapshots.invalidate();
  };
  return {
    async *watchDashboard(request, context) {
      if (subscribers++ === 0) {
        snapshots.invalidate();
        application.services.githubScheduler.on("tick", invalidate);
        application.services.githubScheduler.on("change", invalidate);
        releaseEvents = application.store.subscribeEvents(() => {
          application.services.githubScheduler.emit("change");
        });
      }
      const releaseHeartbeat = application.services.githubScheduler.dashboardInterest();
      let release = () => {};
      try {
        if (request.reviews && request.url !== "") release = application.services.githubScheduler.interest(request.url);
        while (!context.signal.aborted) {
          const view =
            request.reviews && request.url !== ""
              ? application.services.githubScheduler.reviewState(request.url)
              : undefined;
          const snapshot = snapshots.read();
          const frame = {
            snapshot,
            pullRequest: wireDetails(view?.details),
            refresh: wireRefresh(
              request.reviews
                ? view?.schedule
                : application.store.schedules.get(
                    `tracking:${snapshot.tracking?.prs.find((pr) => pr.url === request.url)?.id ?? ""}`,
                  ),
            ),
          };
          let resume = () => {};
          const tick = new Promise<void>((resolve) => {
            resume = resolve;
          });
          const scheduler = application.services.githubScheduler;
          const signal = AbortSignal.any([context.signal, scheduler.signal]);
          scheduler.once("tick", resume);
          scheduler.once("change", resume);
          scheduler.once("heartbeat", resume);
          signal.addEventListener("abort", resume, { once: true });
          try {
            yield frame;
            if (!signal.aborted) await tick;
          } finally {
            scheduler.off("tick", resume);
            scheduler.off("change", resume);
            scheduler.off("heartbeat", resume);
            signal.removeEventListener("abort", resume);
          }
          if (signal.aborted) break;
        }
      } finally {
        release();
        releaseHeartbeat();
        if (--subscribers === 0) {
          application.services.githubScheduler.off("tick", invalidate);
          application.services.githubScheduler.off("change", invalidate);
          releaseEvents?.();
          releaseEvents = undefined;
        }
      }
    },
  };
}
