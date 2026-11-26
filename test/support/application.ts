import { assembleApplication } from "../../src/application/composition.js";
import type { ApplicationOptions } from "../../src/application/options.js";

// Integration fixtures expose owned components without expanding the CLI's application handle.
export async function createApplicationFixture(directory: string, options: ApplicationOptions = {}) {
  const assembly = await assembleApplication(directory, options);
  const { runtime, jobs, services, store, inputs, diagnostics, transport } = assembly;
  return {
    ...services,
    inputs,
    store,
    diagnostics,
    directory,
    socketPath: transport.socketPath,
    start: () => runtime.start(),
    close: () => runtime.close(),
    lifecycle: runtime.lifecycle.bind(runtime),
    nativeAdmission: runtime.nativeAdmission.bind(runtime),
    isStopping: () => runtime.isStopping(),
    command: jobs.command.bind(jobs),
    snapshot: () => jobs.snapshot(),
    tick: () => {
      jobs.tick();
    },
    once(_event: "retired", listener: () => void) {
      runtime.onRetired(listener);
    },
  };
}
export type ApplicationFixture = Awaited<ReturnType<typeof createApplicationFixture>>;
