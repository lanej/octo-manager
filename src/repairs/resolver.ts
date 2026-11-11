import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  record,
  single,
  type RepairProfile,
  type RepairWorkerTask,
} from "./types.js";
import type { RebaseWorkspace } from "./git.js";
export type ResolveConflicts = (
  workspace: RebaseWorkspace,
  paths: string[],
  profile: RepairProfile,
  signal: AbortSignal,
) => Promise<void>;
export const resolveWithWorker: ResolveConflicts = async (
  workspace,
  paths,
  profile,
  signal,
) => {
  signal.throwIfAborted();
  const task: RepairWorkerTask = {
    kind: "repair_conflicts",
    paths,
    instructions: profile.instructions,
  };
  const child = fork(
    fileURLToPath(new URL("../worker.js", import.meta.url)),
    [],
    {
      cwd: workspace.directory,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    },
  );
  let completed = false;
  let failure: Error | undefined;
  let tools = Promise.resolve();
  const stop = () => {
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, profile.timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        if (!completed || failure !== undefined || signal.aborted)
          reject(
            failure ?? new Error("Repair session interrupted or timed out"),
          );
        else resolve();
      });
      child.on("message", (value: unknown) => {
        let message: Record<string, unknown>;
        try {
          message = record(value);
        } catch {
          failure = new Error("Invalid worker message");
          stop();
          return;
        }
        if (message["type"] === "done") {
          completed = true;
          return;
        }
        if (message["type"] === "failure") {
          failure = new Error(
            typeof message["error"] === "string"
              ? message["error"].slice(0, 2000)
              : "Repair worker failed",
          );
          return;
        }
        if (message["type"] !== "tool") return;
        tools = tools
          .then(async () => {
            const id = single(message["id"], "tool ID");
            try {
              const args = record(message["args"]);
              const path = single(args["path"], "file path", 4000);
              let result: unknown;
              if (message["name"] === "read_file")
                result = await workspace.read(path);
              else if (message["name"] === "write_file") {
                if (!paths.includes(path))
                  throw new Error(
                    "This path is outside the current conflict set",
                  );
                const content = args["content"];
                if (typeof content !== "string")
                  throw new Error("Resolution must be text");
                await workspace.write(path, content);
                result =
                  "Resolution written; Octo will validate and continue the rebase.";
              } else throw new Error("Unsupported repair tool");
              if (child.connected)
                child.send({ type: "tool_result", id, result });
            } catch (error) {
              if (child.connected)
                child.send({
                  type: "tool_result",
                  id,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Repair tool failed",
                });
            }
          })
          .catch((error: unknown) => {
            failure =
              error instanceof Error ? error : new Error("Repair tool failed");
            stop();
          });
      });
      child.send({ type: "start", attempt: 1, task, model: profile.model });
    });
    await tools;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null && child.signalCode === null) stop();
  }
};
