import { join } from "node:path";
import { Store } from "../coordinator/store.js";
import { WorkScheduler } from "../scheduling/work.js";
import { PerformanceDiagnostics } from "../diagnostics/service.js";
import { performanceScope } from "../diagnostics/scope.js";
import { workerModule } from "../package-root.js";
import { JobRuntime } from "../jobs/runtime.js";
import { schedulerRoutes } from "../api/routes.js";
import { errorText } from "../text.js";
import { ApplicationInputs } from "./inputs.js";
import { createServices, type Closeable } from "./services.js";
import { ApplicationRuntime, type Application } from "./runtime.js";
import { ApiTransport } from "./transport.js";
import type { ApplicationOptions } from "./options.js";

export async function assembleApplication(
  directory: string,
  options: ApplicationOptions = {},
) {
  const now = options.now ?? Date.now;
  const diagnostics = new PerformanceDiagnostics(directory);
  const inputs = new ApplicationInputs();
  let store: Store | undefined;
  const resources: Closeable[] = [];
  const register = <T extends Closeable>(service: T): T => {
    resources.push(service);
    return service;
  };
  try {
    const ownedStore = new Store(directory, now, inputs.changed, inputs.jobs);
    store = ownedStore;
    const workScheduler = new WorkScheduler(
      now,
      (key, error) => {
        ownedStore.event(
          "",
          "scheduler_work_failed",
          `${key}: ${errorText(error)}`,
        );
      },
      (key, work) => performanceScope(directory, key, work),
    );
    register(workScheduler);
    const policyWork = workScheduler.task("repository-policy", () =>
      ownedStore.repositories.scheduled(now()),
    );
    ownedStore.repositories.watch(policyWork.wake);
    register({
      close: () => {
        ownedStore.repositories.close();
        return Promise.resolve();
      },
    });
    const services = createServices(
      directory,
      ownedStore,
      options,
      inputs,
      register,
    );
    const jobs = register(
      new JobRuntime(
        directory,
        ownedStore,
        {
          now,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.workerEnv === undefined
            ? {}
            : { workerEnv: options.workerEnv }),
          workerPath:
            options.workerPath ??
            workerModule("job", new URL("../worker.js", import.meta.url).href),
        },
        workScheduler,
        () => services.githubScheduler.emit("tick"),
      ),
    );
    inputs.bind({
      changed: (scope) => {
        services.changed(scope);
        if (
          scope?.source === undefined ||
          scope.source === "tracking" ||
          scope.source === "merge"
        )
          policyWork.wake();
      },
      jobs: () => {
        jobs.wake();
      },
      recipient: (agentId) => {
        services.recipient(agentId);
      },
    });
    jobs.recover();
    const transport = new ApiTransport(join(directory, "run.sock"));
    const runtime = new ApplicationRuntime(
      ownedStore,
      jobs,
      services,
      workScheduler,
      policyWork,
      diagnostics,
      transport,
    );
    const api = {
      store: ownedStore,
      services,
      jobs,
      inputs,
      runtime,
      diagnostics,
    };
    transport.configure((router) => {
      schedulerRoutes(api, router);
    });
    return {
      runtime,
      store: ownedStore,
      services,
      jobs,
      inputs,
      diagnostics,
      transport,
    };
  } catch (error) {
    const outcomes = await Promise.allSettled(
      resources.reverse().map((resource) => resource.close()),
    );
    const failures = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    diagnostics.close();
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        "Application assembly cleanup failed",
      );
    store?.close();
    throw error;
  }
}
export async function createApplication(
  directory: string,
  options: ApplicationOptions = {},
): Promise<Application> {
  return (await assembleApplication(directory, options)).runtime;
}
