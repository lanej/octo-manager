import { QuotaHistory, type QuotaForecast } from "./forecast.js";
export type GitHubResource = "core" | "graphql";
export interface GitHubBudget {
  limit: number;
  remaining: number;
  resetAtMs: number;
  observedAtMs: number;
  forecast?: QuotaForecast;
}
export interface GitHubTrafficBucket {
  startedAtMs: number;
  rest: number;
  graphql: number;
  cacheReuses: number;
}
export type GitHubReadMinute = GitHubTrafficBucket;
export type GitHubReadHour = GitHubTrafficBucket;

export interface GitHubReadUsage {
  startedAtMs: number;
  sampledAtMs: number;
  requests: number;
  cacheReuses: number;
  rateLimits: number;
  minutes: GitHubReadMinute[];
  hours: GitHubReadHour[];
  rest?: GitHubBudget;
  graphql?: GitHubBudget;
  restRetryAtMs: number;
  graphqlRetryAtMs: number;
}
function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
export class GitHubUsage {
  private readonly startedAtMs: number;
  private requests = 0;
  private cacheReuses = 0;
  private rateLimits = 0;
  private readonly minutes = new Map<number, GitHubTrafficBucket>();
  private readonly hours = new Map<number, GitHubTrafficBucket>();
  private readonly quotaHistory = new QuotaHistory();
  private readonly budgets: Partial<Record<GitHubResource, GitHubBudget>> = {};
  constructor(private readonly now: () => number) {
    this.startedAtMs = now();
  }
  private bucket(
    buckets: Map<number, GitHubTrafficBucket>,
    at: number,
    span: number,
    capacity: number,
  ): GitHubTrafficBucket {
    const start = Math.floor(at / span) * span;
    for (const key of buckets.keys())
      if (key < start - (capacity - 1) * span) buckets.delete(key);
    let bucket = buckets.get(start);
    if (bucket === undefined) {
      bucket = { startedAtMs: start, rest: 0, graphql: 0, cacheReuses: 0 };
      buckets.set(start, bucket);
    }
    return bucket;
  }
  private window(
    buckets: Map<number, GitHubTrafficBucket>,
    at: number,
    span: number,
    capacity: number,
  ): GitHubTrafficBucket[] {
    const latest = Math.floor(at / span) * span;
    const earliest = Math.max(
      latest - (capacity - 1) * span,
      Math.floor(this.startedAtMs / span) * span,
    );
    for (const key of buckets.keys()) if (key < earliest) buckets.delete(key);
    const result: GitHubTrafficBucket[] = [];
    for (let start = earliest; start <= latest; start += span)
      result.push({
        ...(buckets.get(start) ?? {
          startedAtMs: start,
          rest: 0,
          graphql: 0,
          cacheReuses: 0,
        }),
      });
    return result;
  }
  attempt(resource: GitHubResource): void {
    this.requests++;
    const at = this.now();
    for (const bucket of [
      this.bucket(this.minutes, at, 60000, 60),
      this.bucket(this.hours, at, 3600000, 168),
    ]) {
      if (resource === "core") bucket.rest++;
      else bucket.graphql++;
    }
  }
  reused(): void {
    this.cacheReuses++;
    const at = this.now();
    this.bucket(this.minutes, at, 60000, 60).cacheReuses++;
    this.bucket(this.hours, at, 3600000, 168).cacheReuses++;
  }
  limited(): void {
    this.rateLimits++;
  }
  observe(resource: GitHubResource, headers: Map<string, string>): void {
    const named = headers.get("x-ratelimit-resource");
    if (named !== undefined && named !== resource) return;
    const limit = integer(headers.get("x-ratelimit-limit"));
    const remaining = integer(headers.get("x-ratelimit-remaining"));
    const reset = integer(headers.get("x-ratelimit-reset"));
    if (
      limit === undefined ||
      limit < 1 ||
      limit > 0xffffffff ||
      remaining === undefined ||
      remaining > limit ||
      reset === undefined ||
      reset < 1 ||
      !Number.isSafeInteger(reset * 1000)
    )
      return;
    this.budgets[resource] = {
      limit,
      remaining,
      resetAtMs: reset * 1000,
      observedAtMs: this.now(),
    };
    this.quotaHistory.observe(resource, this.budgets[resource]);
  }
  snapshot(retryAtMs: Record<GitHubResource, number>): GitHubReadUsage {
    const at = this.now();
    const minutes = this.window(this.minutes, at, 60000, 60);
    const hours = this.window(this.hours, at, 3600000, 168);
    return {
      startedAtMs: this.startedAtMs,
      sampledAtMs: at,
      requests: this.requests,
      cacheReuses: this.cacheReuses,
      rateLimits: this.rateLimits,
      minutes,
      hours,
      ...(this.budgets.core === undefined
        ? {}
        : {
            rest: {
              ...this.budgets.core,
              forecast: this.quotaHistory.forecast(
                "core",
                this.budgets.core,
                at,
              ),
            },
          }),
      ...(this.budgets.graphql === undefined
        ? {}
        : {
            graphql: {
              ...this.budgets.graphql,
              forecast: this.quotaHistory.forecast(
                "graphql",
                this.budgets.graphql,
                at,
              ),
            },
          }),
      restRetryAtMs: retryAtMs.core,
      graphqlRetryAtMs: retryAtMs.graphql,
    };
  }
}
