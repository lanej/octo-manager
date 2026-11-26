import type { Store } from "../coordinator/store.js";
import type { PerformanceDiagnostics } from "../diagnostics/service.js";
import type { JobRuntime } from "../jobs/runtime.js";
import type { ApplicationInputs } from "./inputs.js";
import type { ApplicationRuntime } from "./runtime.js";
import type { ApplicationServices } from "./services.js";

export interface ApplicationApi {
  store: Store;
  services: Pick<
    ApplicationServices,
    "tracking" | "assessments" | "githubScheduler" | "merging" | "repairs" | "digests" | "issues"
  >;
  jobs: Pick<JobRuntime, "command" | "snapshot">;
  inputs: Pick<ApplicationInputs, "changed">;
  runtime: Pick<ApplicationRuntime, "lifecycle" | "nativeAdmission" | "isStopping">;
  diagnostics: PerformanceDiagnostics;
}
export type SnapshotSource = Pick<ApplicationApi, "store" | "services" | "jobs">;
