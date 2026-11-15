import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
const Output = Type.Object(
  { blockers: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }) },
  { additionalProperties: false },
);
export async function validateDiagrams(
  diagrams: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (diagrams.length === 0) return [];
  signal?.throwIfAborted();
  const path = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./mermaid-worker.ts"
        : "./mermaid-worker.js",
      import.meta.url,
    ),
  );
  const child = fork(path, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { PATH: process.env["PATH"] ?? "" },
  });
  let result: string[] | undefined, failure: Error | undefined;
  const stop = () => {
    failure = new Error("Mermaid validation cancelled");
    child.kill("SIGKILL");
  };
  const timeout = setTimeout(() => {
    failure = new Error("Mermaid validator timed out");
    child.kill("SIGKILL");
  }, 15000);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        if (failure !== undefined) reject(failure);
        else if (result === undefined)
          reject(new Error("Mermaid validator interrupted"));
        else resolve(result);
      });
      child.on("message", (value: unknown) => {
        if (Check(Output, value)) result = value.blockers;
        else if (
          typeof value === "object" &&
          value !== null &&
          "failure" in value &&
          typeof value.failure === "string"
        )
          failure = new Error("Mermaid validator failed: " + value.failure);
        else {
          failure = new Error("Invalid Mermaid validator response");
          child.kill("SIGKILL");
        }
      });
      child.send({ diagrams });
      if (signal?.aborted === true) stop();
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
