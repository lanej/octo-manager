import {
  sdkTransport,
  type GitHubTransport,
  type GitHubResponse,
  type GitHubRequest,
} from "./github-sdk.js";
import {
  GitHubUsage,
  type GitHubReadUsage,
  type GitHubResource,
} from "./github-usage.js";
interface CachedResponse {
  etag: string;
  body: string;
}
type Resource = GitHubResource;
export interface GitHubQueryResult {
  data: Record<string, unknown>;
  errors: unknown[];
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
export class GitHubHTTPError extends Error {
  constructor(
    readonly status: number,
    message = `GitHub read failed (HTTP ${String(status)})`,
  ) {
    super(message);
  }
}
export class GitHubReads {
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<string, CachedResponse>();
  private cacheBytes = 0;
  private retryAtMs: Record<Resource, number> = { core: 0, graphql: 0 };
  private rateLimitAttempts: Record<Resource, number> = { core: 0, graphql: 0 };
  private readonly metrics: GitHubUsage;
  constructor(
    private run: GitHubTransport = sdkTransport(),
    private now: () => number = Date.now,
  ) {
    this.metrics = new GitHubUsage(now);
  }
  usage(): GitHubReadUsage {
    return this.metrics.snapshot(this.retryAtMs);
  }
  read(path: string, signal?: AbortSignal): Promise<unknown> {
    // rationale: Share one read queue and cooldown across tracking, repairs, submissions, and review clients.
    return this.enqueue(() => this.request(path, signal));
  }
  query(query: string, signal?: AbortSignal): Promise<GitHubQueryResult> {
    return this.enqueue(async () => {
      const result = await this.exchange(
        { method: "POST", path: "graphql", data: { query } },
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
  write(
    path: string,
    fields: Record<string, string | boolean>,
    signal?: AbortSignal,
    beforeSend?: () => void,
  ): Promise<unknown> {
    return this.enqueue(async () => {
      return json(
        (
          await this.exchange(
            { method: "PUT", path, data: fields },
            "core",
            signal,
            beforeSend,
          )
        ).body,
      );
    });
  }
  raw(
    path: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GitHubResponse> {
    return this.enqueue(() =>
      this.exchange({ method: "GET", path, headers }, "core", signal),
    );
  }
  post(
    path: string,
    fields: Record<string, string | boolean>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.enqueue(async () =>
      json(
        (
          await this.exchange(
            { method: "POST", path, data: fields },
            "core",
            signal,
          )
        ).body,
      ),
    );
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
    const result = await this.exchange(
      {
        method: "GET",
        path,
        headers: cached === undefined ? {} : { "if-none-match": cached.etag },
      },
      "core",
      signal,
    );
    if (result.status === 304) {
      if (cached === undefined)
        throw new Error("GitHub returned 304 without cached evidence");
      this.remember(path, cached);
      this.metrics.reused();
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
    request: GitHubRequest,
    resource: Resource,
    signal?: AbortSignal,
    beforeSend?: () => void,
  ): Promise<GitHubResponse> {
    signal?.throwIfAborted();
    if (this.now() < this.retryAtMs[resource])
      throw new GitHubRateLimitError(this.retryAtMs[resource]);
    this.metrics.attempt(resource);
    const result = await this.run(request, signal, beforeSend);
    this.metrics.observe(resource, result.headers);
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
    if (limited) {
      this.metrics.limited();
      throw new GitHubRateLimitError(this.retryAtMs[resource]);
    }
    if (
      result.status !== 304 &&
      (result.status < 200 || result.status >= 300)
    ) {
      if (result.status === 401)
        throw new GitHubHTTPError(
          401,
          "GitHub authentication required: run gh auth login -h github.com",
        );
      if (result.status >= 500)
        throw new Error("GitHub temporarily unavailable");
      throw new GitHubHTTPError(result.status);
    }
    this.rateLimitAttempts[resource] = 0;
    return result;
  }
}
export const githubReads = new GitHubReads();
