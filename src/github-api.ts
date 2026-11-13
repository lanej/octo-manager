import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
interface Response {
  status: number;
  headers: Map<string, string>;
  body: string;
}
interface CachedResponse {
  etag: string;
  body: string;
}
type Resource = "core" | "graphql";
export interface GitHubQueryResult {
  data: Record<string, unknown>;
  errors: unknown[];
}
export type GitHubCommand = (
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;
const command: GitHubCommand = async (args, signal) => {
  try {
    const { stdout } = await exec("gh", args, {
      signal,
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // rationale: gh exits nonzero for HTTP errors, but --include retains the response and rate-limit headers.
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.startsWith("HTTP/")
    )
      return error.stdout;
    throw new Error(
      signal?.aborted === true
        ? "GitHub read cancelled"
        : "GitHub unavailable; check gh authentication, access, and connectivity",
    );
  }
};
function response(raw: string): Response {
  const boundary = /\r?\n\r?\n/u.exec(raw);
  if (boundary === null) throw new Error("Invalid GitHub HTTP response");
  const lines = raw.slice(0, boundary.index).split(/\r?\n/u);
  const status = /^HTTP\/[\d.]+ (\d{3})\b/u.exec(lines.shift() ?? "");
  if (status?.[1] === undefined) throw new Error("Invalid GitHub HTTP status");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(
        line.slice(0, colon).toLowerCase(),
        line.slice(colon + 1).trim(),
      );
  }
  return {
    status: Number(status[1]),
    headers,
    body: raw.slice(boundary.index + boundary[0].length),
  };
}
function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const result = Number(value) * 1000;
  return Number.isSafeInteger(result) ? result : undefined;
}
function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Invalid GitHub JSON response");
  }
}
export class GitHubRateLimitError extends Error {
  constructor(readonly retryAtMs: number) {
    super(
      `GitHub rate limit; reads paused until ${new Date(retryAtMs).toISOString()}`,
    );
    this.name = "GitHubRateLimitError";
  }
}
export class GitHubReads {
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<string, CachedResponse>();
  private cacheBytes = 0;
  private retryAtMs: Record<Resource, number> = { core: 0, graphql: 0 };
  private rateLimitAttempts: Record<Resource, number> = { core: 0, graphql: 0 };
  constructor(
    private run: GitHubCommand = command,
    private now: () => number = Date.now,
  ) {}
  read(path: string, signal?: AbortSignal): Promise<unknown> {
    // rationale: Share one read queue and cooldown across tracking, repairs, submissions, and review clients.
    return this.enqueue(() => this.request(path, signal));
  }
  query(query: string, signal?: AbortSignal): Promise<GitHubQueryResult> {
    return this.enqueue(async () => {
      const result = await this.exchange(
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "POST",
          "--include",
          "graphql",
          "-f",
          `query=${query}`,
        ],
        "graphql",
        signal,
      );
      const value = json(result.body);
      if (
        typeof value !== "object" ||
        value === null ||
        !("data" in value) ||
        typeof value.data !== "object" ||
        value.data === null ||
        Array.isArray(value.data) ||
        ("errors" in value && !Array.isArray(value.errors))
      )
        throw new Error("GitHub GraphQL query failed; evidence unavailable");
      return {
        data: Object.fromEntries(Object.entries(value.data)),
        errors:
          "errors" in value && Array.isArray(value.errors) ? value.errors : [],
      };
    });
  }
  private enqueue<T>(workItem: () => Promise<T>): Promise<T> {
    const work = this.queue.then(workItem);
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  private remember(path: string, value: CachedResponse | undefined): void {
    const previous = this.cache.get(path);
    if (previous !== undefined) {
      this.cacheBytes -= Buffer.byteLength(previous.body);
      this.cache.delete(path);
    }
    if (value === undefined) return;
    this.cache.set(path, value);
    this.cacheBytes += Buffer.byteLength(value.body);
    while (this.cache.size > 128 || this.cacheBytes > 16 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.remember(oldest, undefined);
    }
  }
  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    const cached = this.cache.get(path);
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      path,
      ...(cached === undefined
        ? []
        : ["--header", `If-None-Match: ${cached.etag}`]),
    ];
    const result = await this.exchange(args, "core", signal);
    if (result.status === 304) {
      if (cached === undefined)
        throw new Error("GitHub returned 304 without cached evidence");
      this.remember(path, cached);
      return json(cached.body);
    }
    const value = json(result.body);
    const etag = result.headers.get("etag");
    this.remember(
      path,
      etag === undefined ? undefined : { etag, body: result.body },
    );
    return value;
  }
  private async exchange(
    args: string[],
    resource: Resource,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    if (this.now() < this.retryAtMs[resource])
      throw new GitHubRateLimitError(this.retryAtMs[resource]);
    const result = response(await this.run(args, signal));
    const body =
      resource === "graphql" && result.status === 200
        ? json(result.body)
        : undefined;
    const graphqlLimited =
      typeof body === "object" &&
      body !== null &&
      "errors" in body &&
      Array.isArray(body.errors) &&
      body.errors.some(
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          (("type" in error && error.type === "RATE_LIMITED") ||
            ("message" in error &&
              typeof error.message === "string" &&
              /rate.limit|abuse detection/iu.test(error.message))),
      );
    const limited =
      graphqlLimited ||
      result.status === 429 ||
      (result.status === 403 &&
        (result.headers.get("x-ratelimit-remaining") === "0" ||
          /rate.limit|abuse detection/iu.test(result.body)));
    if (limited || result.headers.get("x-ratelimit-remaining") === "0") {
      const at = this.now();
      const retryAfter = seconds(result.headers.get("retry-after"));
      const reset =
        result.headers.get("x-ratelimit-remaining") === "0"
          ? seconds(result.headers.get("x-ratelimit-reset"))
          : undefined;
      const fallback =
        60000 * 2 ** Math.min(this.rateLimitAttempts[resource], 4);
      if (limited) this.rateLimitAttempts[resource]++;
      const deadline = Math.max(
        at + 1000,
        retryAfter === undefined ? 0 : at + retryAfter,
        reset === undefined ? 0 : reset + 1000,
        retryAfter === undefined && reset === undefined ? at + fallback : 0,
      );
      this.retryAtMs[resource] = deadline;
      if (limited && result.headers.get("x-ratelimit-remaining") !== "0") {
        const other = resource === "core" ? "graphql" : "core";
        this.retryAtMs[other] = Math.max(this.retryAtMs[other], deadline);
        this.rateLimitAttempts[other] = Math.max(
          this.rateLimitAttempts[other],
          this.rateLimitAttempts[resource],
        );
      }
    }
    if (limited) throw new GitHubRateLimitError(this.retryAtMs[resource]);
    if (
      result.status !== 304 &&
      (result.status < 200 || result.status >= 300)
    ) {
      if (result.status === 401)
        throw new Error(
          "GitHub authentication required: run gh auth login -h github.com",
        );
      if (result.status >= 500)
        throw new Error("GitHub temporarily unavailable");
      throw new Error(`GitHub read failed (HTTP ${String(result.status)})`);
    }
    this.rateLimitAttempts[resource] = 0;
    return result;
  }
}
export const githubReads = new GitHubReads();
