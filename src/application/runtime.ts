import { Activation, type ActivationReport } from "../lifecycle.js";
import { githubReads } from "../github/reads.js";
import type { PerformanceDiagnostics } from "../diagnostics/service.js";
import type { Store } from "../coordinator/store.js";
import type { JobRuntime } from "../jobs/runtime.js";
import type { WorkScheduler, ScheduledTask } from "../scheduling/work.js";
import type { ApplicationServices } from "./services.js";
import type { ApiTransport } from "./transport.js";

export interface Application {
  start(): Promise<void>;
  close(): Promise<void>;
  onRetired(listener: () => void): () => void;
}
export class ApplicationRuntime implements Application {
  private readonly activation = new Activation();
  private nativeCalls = 0;
  private stopping = false;
  private stopped = false;
  private startWork: Promise<void> | undefined;
  private closeWork: Promise<void> | undefined;
  private disposeWork: Promise<void> | undefined;
  private checkpointWork: Promise<ActivationReport> | undefined;
  private releaseDispatch: (() => void) | undefined;
  private listeners = new Set<() => void>();
  constructor(
    private store: Store,
    private jobs: JobRuntime,
    private services: ApplicationServices,
    private workScheduler: WorkScheduler,
    private policyWork: ScheduledTask,
    private diagnostics: PerformanceDiagnostics,
    private transport: ApiTransport,
  ) {}
  onRetired(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private retired(): void {
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  isStopping(): boolean {
    return this.stopping || this.stopped;
  }
  start(): Promise<void> {
    if (this.isStopping())
      return Promise.reject(new Error("Coordinator is stopping"));
    return (this.startWork ??= (async () => {
      try {
        await this.transport.listen();
        if (this.isStopping()) throw new Error("Coordinator is stopping");
        this.releaseDispatch = githubReads.setDispatcher(
          this.services.githubScheduler,
        );
        this.services.start(this.workScheduler);
        this.jobs.wake();
        this.policyWork.wake();
        this.workScheduler.start();
      } catch (error) {
        this.stopping = true;
        await this.dispose();
        throw error;
      }
    })());
  }
  nativeAdmission(method: string): () => void {
    if (method === "RuntimeLifecycle" || method === "GetServerInfo")
      return () => {};
    if (this.stopping) throw new Error("Coordinator is stopping");
    this.nativeCalls++;
    return () => {
      this.nativeCalls--;
    };
  }
  async lifecycle(
    action: string,
    incarnation: string,
    operation: string,
    expected: string,
    restorePaused?: boolean,
  ): Promise<ActivationReport> {
    const report = () =>
      this.activation.report(
        this.transport.listening && !this.stopping,
        this.store.paused(),
      );
    if (action === "inventory") return report();
    if (action === "verify") {
      const value = report();
      if (
        this.activation.identity === null ||
        expected !== this.activation.identity
      ) {
        value.targets[0].ready = false;
        value.targets[0].reason =
          "native-loaded-image-unavailable-or-selection-differs";
      }
      return value;
    }
    if (action === "stop") {
      try {
        const submitted = this.activation.stop(incarnation, operation);
        const value = report();
        if (submitted)
          setTimeout(() => {
            void this.close()
              .then(() => {
                this.retired();
              })
              .catch(() => {
                // Keep the fenced owner alive if graceful retirement cannot be established.
                setInterval(() => {}, 1000);
              });
          }, 100).unref();
        return value;
      } catch (error) {
        const value = report();
        value.targets[0].reason =
          error instanceof Error ? error.message : "Native retirement refused";
        value.targets[0].stop_accepted = false;
        return value;
      }
    }

    if (action === "restore") {
      if (
        this.stopping ||
        this.activation.identity === null ||
        expected !== this.activation.identity
      ) {
        const value = report();
        value.targets[0].reason =
          "original-octo-drain-cannot-be-reversed-or-image-differs";
        return value;
      }
      if (
        this.activation.restore(incarnation, operation) &&
        restorePaused !== undefined
      )
        this.store.setPaused(restorePaused);
      return report();
    }
    if (action !== "checkpoint")
      throw new Error("Unsupported lifecycle action");
    if (this.checkpointWork !== undefined) {
      const current = report().targets[0];
      if (
        current.process.native_id === incarnation &&
        current.checkpoint?.run_id === operation
      ) {
        await this.checkpointWork;
        return report();
      }
    }
    if (
      this.activation.identity === null ||
      report().targets[0].retirement_policy !== "successful-exit" ||
      this.nativeCalls !== 0 ||
      !this.jobs.checkpointable() ||
      !this.services.checkpointable()
    ) {
      const value = report();
      value.targets[0].checkpoint = { state: "refused", run_id: operation };
      value.targets[0].reason =
        "active-octo-work-has-no-confirmed-native-checkpoint-or-image-is-unmanaged";
      return value;
    }
    try {
      this.activation.claim(incarnation, operation);
    } catch (error) {
      const value = report();
      value.targets[0].checkpoint = { state: "refused", run_id: operation };
      value.targets[0].reason =
        error instanceof Error ? error.message : "Native checkpoint refused";
      return value;
    }
    this.stopping = true;
    this.store.setPaused(true);
    this.workScheduler.stop();
    this.jobs.stop();
    this.policyWork.close();
    this.store.repositories.close();
    this.services.stopIntake();
    this.checkpointWork = (async () => {
      await this.services.close();
      await this.workScheduler.close();
      this.diagnostics.close();
      this.activation.confirm();
      return report();
    })();
    return this.checkpointWork;
  }

  close(): Promise<void> {
    if (this.closeWork !== undefined) return this.closeWork;
    this.stopping = true;
    this.workScheduler.stop();
    this.jobs.stop(true);
    this.policyWork.close();
    this.store.repositories.close();
    this.services.stopIntake();
    this.services.githubScheduler.emit("tick");
    this.closeWork = (async () => {
      await this.startWork?.catch(() => {});
      await this.checkpointWork;
      await this.dispose();
    })();
    return this.closeWork;
  }
  private dispose(): Promise<void> {
    return (this.disposeWork ??= (async () => {
      this.workScheduler.stop();
      this.jobs.stop(true);
      this.policyWork.close();
      this.store.repositories.close();
      this.services.stopIntake();
      await this.services.close();
      await this.workScheduler.close();
      await this.jobs.close();
      await this.transport.close();
      this.jobs.finish();
      this.diagnostics.close();
      this.releaseDispatch?.();
      this.store.close();
      this.stopped = true;
    })());
  }
}
