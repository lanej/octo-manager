import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  inputLimit,
  outputLimit,
  timeoutMs,
  result,
  type AssessmentInput,
  type AssessmentResult,
} from "./contracts.js";
export type Assess = (
  input: AssessmentInput,
  model: string,
  signal: AbortSignal,
) => Promise<AssessmentResult>;
export function assessmentRunner(
  workerPath = fileURLToPath(new URL("./worker.js", import.meta.url)),
  timeout = timeoutMs,
): Assess {
  return async (input, model, signal) => {
    signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(input)) > inputLimit)
      throw new Error("Oversized assessment input");
    const child = fork(workerPath, [], {
      cwd: tmpdir(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    });
    let output: AssessmentResult | undefined;
    let failure = false;
    const stop = () => {
      failure = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeout);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (failure || code !== 0 || output === undefined || signal.aborted)
            reject(new Error("Assessment unavailable"));
          else resolve();
        });
        child.on("message", (value: unknown) => {
          if (
            output !== undefined ||
            typeof value !== "object" ||
            value === null ||
            !("type" in value) ||
            value.type !== "done" ||
            !("output" in value) ||
            typeof value.output !== "string" ||
            Buffer.byteLength(value.output) > outputLimit
          ) {
            stop();
            return;
          }
          try {
            output = result(JSON.parse(value.output));
          } catch {
            stop();
          }
        });
        child.send({ input, model }, (error) => {
          if (error !== null) stop();
        });
      });
      if (output === undefined) throw new Error("Assessment unavailable");
      return output;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  };
}
