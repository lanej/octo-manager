export type GitHubResource = "core" | "graphql";
export interface GitHubBudget {
  limit: number;
  remaining: number;
  resetAtMs: number;
  observedAtMs: number;
}
export interface GitHubReadMinute {
  startedAtMs: number;
  rest: number;
  graphql: number;
  cacheReuses: number;
}
export interface GitHubReadUsage {
  startedAtMs: number;
  sampledAtMs: number;
  requests: number;
  cacheReuses: number;
  rateLimits: number;
  minutes: GitHubReadMinute[];
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
  private readonly minutes = new Map<number, GitHubReadMinute>();
  private readonly budgets: Partial<Record<GitHubResource, GitHubBudget>> = {};
  constructor(private readonly now: () => number) {
    this.startedAtMs = now();
  }
  private bucket(): GitHubReadMinute {
    const minute = Math.floor(this.now() / 60000) * 60000;
    for (const at of this.minutes.keys())
      if (at < minute - 59 * 60000) this.minutes.delete(at);
    let bucket = this.minutes.get(minute);
    if (bucket === undefined) {
      bucket = { startedAtMs: minute, rest: 0, graphql: 0, cacheReuses: 0 };
      this.minutes.set(minute, bucket);
    }
    return bucket;
  }
  attempt(resource: GitHubResource): void {
    this.requests++;
    const bucket = this.bucket();
    if (resource === "core") bucket.rest++;
    else bucket.graphql++;
  }
  reused(): void {
    this.cacheReuses++;
    this.bucket().cacheReuses++;
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
  }
  snapshot(retryAtMs: Record<GitHubResource, number>): GitHubReadUsage {
    const at = this.now();
    const latest = Math.floor(at / 60000) * 60000;
    const earliest = Math.max(
      latest - 59 * 60000,
      Math.floor(this.startedAtMs / 60000) * 60000,
    );
    for (const minute of this.minutes.keys())
      if (minute < earliest) this.minutes.delete(minute);
    const minutes: GitHubReadMinute[] = [];
    for (let minute = earliest; minute <= latest; minute += 60000)
      minutes.push({
        ...(this.minutes.get(minute) ?? {
          startedAtMs: minute,
          rest: 0,
          graphql: 0,
          cacheReuses: 0,
        }),
      });
    return {
      startedAtMs: this.startedAtMs,
      sampledAtMs: at,
      requests: this.requests,
      cacheReuses: this.cacheReuses,
      rateLimits: this.rateLimits,
      minutes,
      ...(this.budgets.core === undefined
        ? {}
        : { rest: { ...this.budgets.core } }),
      ...(this.budgets.graphql === undefined
        ? {}
        : { graphql: { ...this.budgets.graphql } }),
      restRetryAtMs: retryAtMs.core,
      graphqlRetryAtMs: retryAtMs.graphql,
    };
  }
}
