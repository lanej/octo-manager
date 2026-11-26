import { releaseModule } from "./package-root.js";
import { closeSync, openSync, readSync } from "node:fs";

export type ReleaseIdentity =
  | { status: "available"; revision: string }
  | {
      status: "unavailable";
      reason: "missing" | "invalid" | "unreadable";
    };

export function releaseIdentity(moduleUrl: string = releaseModule(import.meta.url)): ReleaseIdentity {
  let descriptor: number | undefined;
  try {
    // The running module identifies its release; the caller's working directory may be another checkout.
    descriptor = openSync(new URL("../release.json", moduleUrl), "r");
    const buffer = Buffer.alloc(4097);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > 4096) return { status: "unavailable", reason: "invalid" };
    const metadata: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "revision" in metadata &&
      typeof metadata.revision === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(metadata.revision)
    )
      return { status: "available", revision: metadata.revision };
    return { status: "unavailable", reason: "invalid" };
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof SyntaxError
          ? "invalid"
          : error instanceof Error && "code" in error && error.code === "ENOENT"
            ? "missing"
            : "unreadable",
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function runtimeIdentity(versions: Readonly<Record<string, string | undefined>>) {
  const bun = versions["bun"];
  return bun === undefined ? { name: "node", version: versions["node"] ?? "unknown" } : { name: "bun", version: bun };
}

export function startupRecord(state: string) {
  return {
    ready: true,
    state,
    at: new Date().toISOString(),
    pid: process.pid,
    release: releaseIdentity(),
    runtime: runtimeIdentity(process.versions),
  };
}
