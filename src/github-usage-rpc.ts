import { create } from "@bufbuild/protobuf";
import {
  GitHubReadUsageSchema,
  type GitHubReadUsage as WireUsage,
} from "./gen/octomanager/v1/github_pb.js";
import type { GitHubBudget, GitHubReadUsage } from "./github-usage.js";

function budget(value: GitHubBudget | undefined) {
  return value === undefined
    ? undefined
    : {
        limit: value.limit,
        remaining: value.remaining,
        resetAtMs: BigInt(value.resetAtMs),
        observedAtMs: BigInt(value.observedAtMs),
      };
}
export function wireGitHubUsage(value: GitHubReadUsage): WireUsage {
  return create(GitHubReadUsageSchema, {
    startedAtMs: BigInt(value.startedAtMs),
    sampledAtMs: BigInt(value.sampledAtMs),
    requests: BigInt(value.requests),
    cacheReuses: BigInt(value.cacheReuses),
    rateLimits: BigInt(value.rateLimits),
    rest: budget(value.rest),
    graphql: budget(value.graphql),
    restRetryAtMs: BigInt(value.restRetryAtMs),
    graphqlRetryAtMs: BigInt(value.graphqlRetryAtMs),
    minutes: value.minutes.map((minute) => ({
      startedAtMs: BigInt(minute.startedAtMs),
      rest: BigInt(minute.rest),
      graphql: BigInt(minute.graphql),
      cacheReuses: BigInt(minute.cacheReuses),
    })),
  });
}
