import type { GitHubBudget, GitHubResource } from "./github-usage.js";
export enum ForecastState {
  Unknown = "unknown",
  OnTrack = "on_track",
  AtRisk = "at_risk",
  Exhausted = "exhausted",
}
interface ForecastEvidence {
  reason: string;
  windowMs: number;
  sampledAtMs: number;
}
export type QuotaForecast = ForecastEvidence &
  (
    | { state: ForecastState.Unknown }
    | {
        state: ForecastState.Exhausted;
        unitsPerHour?: number;
        projectedRemainingAtReset: 0;
        exhaustAtMs: number;
      }
    | {
        state: ForecastState.OnTrack | ForecastState.AtRisk;
        unitsPerHour: number;
        projectedRemainingAtReset: number;
        exhaustAtMs?: number;
      }
  );
const windowMs = 600000,
  minimumWindowMs = 120000,
  freshnessMs = 180000;
export function forecastQuota(
  budget: GitHubBudget,
  samples: GitHubBudget[],
  at: number,
): QuotaForecast {
  const unknown = (reason: string): QuotaForecast => ({
    state: ForecastState.Unknown,
    reason,
    windowMs: 0,
    sampledAtMs: budget.observedAtMs,
  });
  if (at < budget.observedAtMs)
    return unknown("Clock moved before the last quota observation");
  if (at >= budget.resetAtMs)
    return unknown("Waiting for a quota observation after reset");
  if (at - budget.observedAtMs > freshnessMs)
    return unknown("Quota observation is stale");
  if (budget.remaining === 0)
    return {
      state: ForecastState.Exhausted,
      reason: "GitHub reported no quota remaining",
      windowMs: 0,
      sampledAtMs: budget.observedAtMs,
      projectedRemainingAtReset: 0,
      exhaustAtMs: budget.observedAtMs,
    };
  const current = samples.filter(
    (sample) =>
      sample.resetAtMs === budget.resetAtMs &&
      sample.limit === budget.limit &&
      sample.observedAtMs >= budget.observedAtMs - windowMs &&
      sample.observedAtMs <= budget.observedAtMs,
  );
  const first = current[0];
  if (first === undefined) return unknown("Waiting for quota history");
  const duration = budget.observedAtMs - first.observedAtMs;
  if (duration < minimumWindowMs || current.length < 2)
    return unknown("Need at least two minutes of quota history");
  const used = first.remaining - budget.remaining;
  if (used < 0)
    return unknown("Quota balance increased within the current window");
  const unitsPerMs = used / duration,
    unitsPerHour = unitsPerMs * 3600000;
  const projectedRemainingAtReset = Math.max(
    0,
    budget.remaining - unitsPerMs * (budget.resetAtMs - budget.observedAtMs),
  );
  const exhaustAtMs =
    unitsPerMs > 0
      ? Math.ceil(budget.observedAtMs + budget.remaining / unitsPerMs)
      : undefined;
  const state =
    exhaustAtMs !== undefined && exhaustAtMs < budget.resetAtMs
      ? ForecastState.AtRisk
      : ForecastState.OnTrack;
  return {
    state,
    reason: "At the recent shared-budget consumption rate",
    windowMs: duration,
    sampledAtMs: budget.observedAtMs,
    unitsPerHour,
    projectedRemainingAtReset,
    ...(exhaustAtMs === undefined ? {} : { exhaustAtMs }),
  };
}
export class QuotaHistory {
  private samples: Partial<Record<GitHubResource, GitHubBudget[]>> = {};
  observe(resource: GitHubResource, budget: GitHubBudget): void {
    let history = this.samples[resource] ?? [];
    const previous = history.at(-1);
    if (
      previous !== undefined &&
      (previous.resetAtMs !== budget.resetAtMs ||
        previous.limit !== budget.limit ||
        budget.remaining > previous.remaining ||
        budget.observedAtMs < previous.observedAtMs)
    )
      history = [];
    if (
      previous !== undefined &&
      Math.floor(previous.observedAtMs / 60000) ===
        Math.floor(budget.observedAtMs / 60000)
    )
      history = history.slice(0, -1);
    history = history.filter(
      (sample) => sample.observedAtMs >= budget.observedAtMs - windowMs,
    );
    history.push({ ...budget });
    this.samples[resource] = history;
  }
  forecast(
    resource: GitHubResource,
    budget: GitHubBudget,
    at: number,
  ): QuotaForecast {
    return forecastQuota(budget, this.samples[resource] ?? [], at);
  }
}
