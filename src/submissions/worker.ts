import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  hash,
  type Role,
  type StageResult,
  type StageTask,
} from "./contracts.js";
import type { TSchema } from "typebox";
export type RunStage = (
  role: Role,
  input: unknown,
  schema: TSchema,
  instructions: string,
  model: string,
  signal: AbortSignal,
  pid: (pid: number, active: boolean) => void,
) => Promise<StageResult>;
export const createStageRunner =
  (workerPath: string): RunStage =>
  async (role, input, schema, instructions, model, signal, pid) => {
    signal.throwIfAborted();
    const task: StageTask = {
      kind: "pr_stage",
      role,
      input,
      schema,
      instructions,
    };
    const child = fork(workerPath, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
      execArgv: [],
    });
    if (child.pid !== undefined) pid(child.pid, true);
    let raw: string | undefined, failure: Error | undefined;
    const stop = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => {
      failure = new Error("PR worker timed out");
      stop();
    }, 120000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, exitSignal) => {
          if (
            failure !== undefined ||
            raw === undefined ||
            signal.aborted ||
            code !== 0
          )
            reject(
              failure ??
                new Error(
                  signal.aborted
                    ? "PR worker interrupted"
                    : `PR worker exited ${raw === undefined ? "without a result" : "before successful completion"} (${String(exitSignal ?? code)})`,
                ),
            );
          else resolve();
        });
        child.on("message", (value: unknown) => {
          if (typeof value !== "object" || value === null) {
            failure = new Error("Invalid PR worker response");
            stop();
            return;
          }
          if (
            "type" in value &&
            value.type === "done" &&
            "text" in value &&
            typeof value.text === "string"
          ) {
            raw = value.text;
            if (child.connected)
              child.send({ type: "result_ack", attempt: 1 }, () => {});
          }
          if ("type" in value && value.type === "failure") {
            failure = new Error(
              "error" in value && typeof value.error === "string"
                ? value.error
                : "PR worker failed",
            );
            if (child.connected)
              child.send({ type: "result_ack", attempt: 1 }, () => {});
          }
          if ("type" in value && value.type === "tool") {
            failure = new Error("PR drafting workers cannot use tools");
            stop();
          }
        });
        child.send({ type: "start", attempt: 1, task, model });
      });
      if (raw === undefined || Buffer.byteLength(raw) > 65536)
        throw new Error("Invalid PR worker output size");
      const json = raw
        .trim()
        .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u, "$1");
      let result: unknown;
      try {
        result = JSON.parse(json);
      } catch {
        result = null;
      }
      return {
        role,
        model,
        promptDigest: hash({ instructions, schema }),
        raw,
        result,
        at: Date.now(),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null) stop();
      if (child.pid !== undefined) pid(child.pid, false);
    }
  };

export const runStage = createStageRunner(
  fileURLToPath(new URL("../worker.js", import.meta.url)),
);
