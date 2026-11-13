import { githubReads, type GitHubQueryResult } from "../github-api.js";
import { trackingPR } from "./evidence.js";
import type { TargetBase } from "./types.js";

export interface PRMetadata {
  pr: ReturnType<typeof trackingPR>;
  description?: string;
  target?: TargetBase;
}
type Query = (
  query: string,
  signal?: AbortSignal,
) => Promise<GitHubQueryResult>;
interface Pending {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (value: PRMetadata) => void;
  reject: (error: unknown) => void;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid GitHub metadata");
  return Object.fromEntries(Object.entries(value));
}
function metadata(value: unknown): PRMetadata {
  const repository = record(value);
  const raw = record(repository["pullRequest"]);
  if (
    !["OPEN", "CLOSED", "MERGED"].includes(String(raw["state"])) ||
    typeof raw["merged"] !== "boolean" ||
    !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(String(raw["mergeable"]))
  )
    throw new Error("Invalid GitHub PR metadata");
  const pr = trackingPR({
    head: { sha: raw["headRefOid"] },
    base: {
      sha: raw["baseRefOid"],
      ref: raw["baseRefName"],
      repo: { private: repository["isPrivate"] },
    },
    state: raw["state"] === "OPEN" ? "open" : "closed",
    merged: raw["merged"],
    mergeable:
      raw["mergeable"] === "UNKNOWN" ? null : raw["mergeable"] === "MERGEABLE",
  });
  if (pr.state !== "open" || pr.merged)
    return {
      pr,
      ...(typeof raw["body"] === "string" ? { description: raw["body"] } : {}),
    };
  const target = record(record(raw["baseRef"])["target"]);
  if (typeof target["oid"] !== "string" || target["oid"] === "")
    throw new Error("GitHub target branch unavailable");
  return {
    pr,
    ...(typeof raw["body"] === "string" ? { description: raw["body"] } : {}),
    target: { ref: pr.base.ref, sha: target["oid"] },
  };
}
export class GitHubMetadata {
  private pending: Pending[] = [];
  private scheduled = false;
  constructor(
    private query: Query = (query, signal) => githubReads.query(query, signal),
  ) {}
  read(url: string, signal?: AbortSignal): Promise<PRMetadata> {
    const result = new Promise<PRMetadata>((resolve, reject) => {
      this.pending.push({ url, signal, resolve, reject });
    });
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        const pending = this.pending.splice(0);
        this.flush(pending).catch((error: unknown) => {
          for (const item of pending) item.reject(error);
        });
      });
    }
    return result;
  }
  private async flush(pending: Pending[]): Promise<void> {
    for (let start = 0; start < pending.length; start += 10) {
      const batch = pending.slice(start, start + 10).filter((item) => {
        if (item.signal?.aborted !== true) return true;
        item.reject(new Error("GitHub read cancelled"));
        return false;
      });
      if (batch.length === 0) continue;
      const fields = batch.map((item, index) => {
        const [, owner, repo, , number] = new URL(item.url).pathname.split("/");
        if (
          owner === undefined ||
          repo === undefined ||
          number === undefined ||
          !/^[1-9]\d*$/u.test(number)
        )
          throw new Error("Invalid GitHub PR URL");
        return `pr${String(index)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
          isPrivate
          pullRequest(number: ${number}) {
            body state merged mergeable headRefOid baseRefOid baseRefName
            baseRef { target { oid } }
          }
        }`;
      });
      const controller = new AbortController();
      const cancel = () => {
        if (batch.every((item) => item.signal?.aborted === true))
          controller.abort();
      };
      for (const item of batch)
        item.signal?.addEventListener("abort", cancel, { once: true });
      cancel();
      try {
        const result = await this.query(
          `query { ${fields.join("\n")} }`,
          controller.signal,
        );
        const failures = result.errors.map((error) => {
          const raw = record(error);
          const path = raw["path"];
          return Array.isArray(path) && typeof path[0] === "string"
            ? path[0]
            : undefined;
        });
        for (const [index, item] of batch.entries()) {
          try {
            item.signal?.throwIfAborted();
            const alias = `pr${String(index)}`;
            if (failures.includes(undefined) || failures.includes(alias))
              throw new Error("GitHub PR metadata unavailable");
            item.resolve(metadata(result.data[alias]));
          } catch (error) {
            item.reject(error);
          }
        }
      } finally {
        for (const item of batch)
          item.signal?.removeEventListener("abort", cancel);
      }
    }
  }
}
export const githubMetadata = new GitHubMetadata();
