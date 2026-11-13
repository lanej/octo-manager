import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  forecastQuota,
  ForecastState,
  QuotaHistory,
} from "../src/github-forecast.js";
import type { GitHubBudget } from "../src/github-usage.js";
const budget = (
  remaining: number,
  observedAtMs: number,
  resetAtMs = 3600000,
): GitHubBudget => ({ limit: 5000, remaining, resetAtMs, observedAtMs });
test("forecasts use observed quota units and time to the actual reset", () => {
  const first = budget(5000, 0),
    fast = budget(4000, 120000),
    slow = budget(4980, 120000);
  const risk = forecastQuota(fast, [first, fast], 120000);
  assert.equal(risk.state, ForecastState.AtRisk);
  assert.equal(risk.unitsPerHour, 30000);
  assert.equal(risk.exhaustAtMs, 600000);
  assert.equal(risk.projectedRemainingAtReset, 0);
  const safe = forecastQuota(slow, [first, slow], 120000);
  assert.equal(safe.state, ForecastState.OnTrack);
  assert.equal(safe.unitsPerHour, 600);
  assert.equal(safe.projectedRemainingAtReset, 4400);
  const almostReset = budget(4000, 120000, 180000);
  assert.equal(
    forecastQuota(
      almostReset,
      [{ ...first, resetAtMs: 180000 }, almostReset],
      120000,
    ).state,
    ForecastState.OnTrack,
  );
});
test("unknown and stale evidence never claims an adequate budget", () => {
  const current = budget(4000, 120000);
  for (const [samples, at] of [
    [[], 120000],
    [[current], 120000],
    [[budget(5000, 60000), current], 120000],
    [[budget(5000, 0), current], 400001],
    [[budget(5000, 0), current], 3600000],
  ] satisfies [GitHubBudget[], number][]) {
    assert.equal(
      forecastQuota(current, samples, at).state,
      ForecastState.Unknown,
    );
  }
});
test("resource histories stay separate and reset/increasing balances invalidate the old trend", () => {
  const history = new QuotaHistory();
  history.observe("core", budget(5000, 0));
  history.observe("graphql", budget(5000, 0));
  history.observe("core", budget(4000, 120000));
  history.observe("graphql", budget(4980, 120000));
  assert.equal(
    history.forecast("core", budget(4000, 120000), 120000).state,
    ForecastState.AtRisk,
  );
  assert.equal(
    history.forecast("graphql", budget(4980, 120000), 120000).state,
    ForecastState.OnTrack,
  );
  const reset = budget(5000, 180000, 7200000);
  history.observe("core", reset);
  assert.equal(
    history.forecast("core", reset, 180000).state,
    ForecastState.Unknown,
  );
  history.observe("graphql", budget(4990, 180000));
  assert.equal(
    history.forecast("graphql", budget(4990, 180000), 180000).state,
    ForecastState.Unknown,
  );
});

test("an observed empty quota is exhausted even before a trend is available", () => {
  const current = budget(0, 1000);
  const value = forecastQuota(current, [current], 1000);
  assert.equal(value.state, ForecastState.Exhausted);
  assert.equal(value.unitsPerHour, undefined);
});
