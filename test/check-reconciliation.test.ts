import { rejects } from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/coordinator/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  readObservation,
  GitHubObservationChangedError,
} from "../src/tracking/github.js";
import {
  checkReplaces,
  checkEvidence,
  checksFinished,
  CheckWatchState,
  storedCheckEvidence,
} from "../src/tracking/checks.js";
import { currentChecks } from "../src/tracking/policy.js";
import { currentMergeChecks } from "../src/merging/checks.js";
import { wire, unwire } from "../src/api/codec.js";
import { GitHubRateLimitError } from "../src/github/reads.js";
import { DomainCheckEvidenceSchema } from "../src/gen/octomanager/v2/domain_pb.js";
import { ActionState } from "../src/tracking/types.js";
import type {
  CheckObservation,
  ObservationInput,
} from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
const target = { harness: "codex", endpoint: "local", sessionId: "reconcile" };
const pr = {
  head: { sha: "head" },
  base: { sha: "base", ref: "main", repo: { private: true } },
  state: "open",
  merged: false,
  mergeable: true,
};
function old(id: number, conclusion = ""): CheckObservation {
  return {
    id: `run:${String(id)}`,
    key: `run:1:job-${String(id)}`,
    name: `job-${String(id)}`,
    headSha: "head",
    status: conclusion === "" ? "in_progress" : "completed",
    conclusion,
    at: 1000,
    url: `https://github.com/owner/repo/actions/runs/9/job/${String(id + 1000)}`,
  };
}
const workflow: CheckObservation = {
  id: "workflow:9:2",
  key: "workflow:9",
  name: "CI",
  headSha: "head",
  status: "completed",
  conclusion: "success",
  at: 2000,
  url,
};
function observation(
  checks: CheckObservation[],
  workflows: CheckObservation[] = [],
): ObservationInput {
  return {
    observedAt: 1000,
    headSha: "head",
    baseSha: "base",
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: checks },
    workflows: { state: "complete", value: workflows },
    reviews: { state: "complete", value: [] },
    feedback: { state: "complete", value: [] },
  };
}
function source(
  job: (id: number) => unknown,
  requested: number[] = [],
  present: readonly CheckObservation[] = [],
) {
  return async (path: string): Promise<unknown> => {
    const id = /\/actions\/jobs\/(\d+)$/u.exec(path)?.[1];
    if (id !== undefined) {
      requested.push(Number(id));
      return await Promise.resolve(job(Number(id)));
    }
    if (/\/pulls\/1$/u.test(path)) return pr;
    if (path.includes("/git/ref/")) return { object: { sha: "base" } };
    if (path.includes("/check-runs"))
      return {
        check_runs: present.map((check) => ({
          id: Number(check.id.slice(4)),
          name: check.name,
          head_sha: check.headSha,
          status: "completed",
          conclusion: "success",
          html_url: check.url,
          app: { id: 1 },
        })),
      };
    if (path.includes("/actions/runs"))
      return {
        workflow_runs: [
          {
            id: 9,
            run_attempt: 2,
            name: "CI",
            head_sha: "head",
            status: "completed",
            conclusion: "success",
            run_started_at: "2026-01-01T00:00:00Z",
            html_url: url,
          },
        ],
      };
    return [];
  };
}
function job(id: number) {
  const checkId = id - 1000;
  return {
    id,
    run_id: 9,
    run_attempt: 1,
    head_sha: "head",
    name: `job-${String(checkId)}`,
    status: "completed",
    conclusion: checkId === 1 ? "failure" : "success",
    check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${String(checkId)}`,
  };
}

test("ordinary refresh repairs a persisted old-attempt watch and retains raw failure audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-reconcile-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const tracked = store.tracking.track(url, target);
  try {
    store.tracking.observe(
      tracked.id,
      observation([old(1, "failure"), old(2)]),
      config,
    );
    const original = store.tracking.checks.list(tracked.id)[0];
    expect(original?.state).toBe(CheckWatchState.Waiting);
    store.tracking.observe(tracked.id, observation([], [workflow]), config);
    store.close();
    store = new Store(directory);
    const requests: number[] = [];
    const service = new TrackingService(store.tracking, config, Date.now, {
      read: (address, signal, _read, now, _metadata, retained) =>
        readObservation(
          address,
          signal,
          source(job, requests),
          now,
          undefined,
          retained,
        ),
    });
    try {
      await service.refresh(tracked.id);
    } finally {
      await service.close();
    }
    const repaired = store.tracking.checks.list(tracked.id).at(-1);
    expect(repaired?.id).toBe(original?.id);
    expect(repaired?.state).toBe(CheckWatchState.Completed);
    expect(repaired?.evidence.state).toBe("complete");
    expect(requests.sort()).toEqual([1001, 1002]);
    const latest = store.tracking.pr(tracked.id).observation;
    expect(latest).toBeDefined();
    if (latest === undefined) throw new Error("Missing observation");
    expect(currentMergeChecks(latest).map((c) => c.id)).toEqual([
      "workflow:9:2",
    ]);
    expect(latest.checks.state).toBe("complete");
    if (latest.checks.state === "unavailable")
      throw new Error("Missing checks");
    expect(latest.checks.value.find((c) => c.id === "run:1")).toMatchObject({
      conclusion: "failure",
      workflowRunId: 9,
      workflowRunAttempt: 1,
    });
    store.close();
    store = new Store(directory);
    expect(store.tracking.pr(tracked.id).observation?.checks).toEqual(
      latest.checks,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown and mismatched execution lookups remain visible and fail closed", async () => {
  for (const patch of [
    { id: 999 },
    { head_sha: "other" },
    { run_id: 10 },
    { run_attempt: 0 },
    { name: "other" },
    { check_run_url: "https://api.github.com/repos/owner/other/check-runs/2" },
  ]) {
    const result = await readObservation(
      url,
      undefined,
      source((id) => ({ ...job(id), ...patch })),
      Date.now,
      undefined,
      { checks: [old(2)] },
    );
    expect(result.checks.state).toBe("partial");
    expect(
      currentMergeChecks(result).some(
        (c) => c.id === "run:2" && c.status === "in_progress",
      ),
    ).toBe(true);
  }
  const unavailable = await readObservation(
    url,
    undefined,
    source(() => Promise.reject(new Error("404"))),
    Date.now,
    undefined,
    { checks: [old(2)] },
  );
  expect(unavailable.checks.state).toBe("partial");
  const requests: number[] = [];
  await readObservation(
    url,
    undefined,
    source(job, requests),
    Date.now,
    undefined,
    {
      checks: [
        { ...old(2), url: "https://other.example/actions/runs/9/job/1002" },
      ],
    },
  );
  expect(requests).toEqual([]);
});

test("ten-lookup budget skips a large present set and progresses beyond a failing prefix across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-cursor-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const tracked = store.tracking.track(url, target);
  const checks = Array.from({ length: 1025 }, (_, i) => old(i + 1));
  const present = checks.slice(25);
  try {
    store.tracking.observe(tracked.id, observation(checks), config);
    const seen = new Set<number>();
    for (let round = 0; round < 3; round++) {
      const current = store.tracking.pr(tracked.id);
      const requests: number[] = [];
      const result = await readObservation(
        url,
        undefined,
        source(
          (id) => {
            if (id < 1021) throw new Error("404");
            return job(id);
          },
          requests,
          present,
        ),
        Date.now,
        undefined,
        store.tracking.checks.reconciliationChecks(
          tracked.id,
          current.observation,
        ),
      );
      expect(requests.length).toBeLessThanOrEqual(10);
      for (const id of requests) seen.add(id);
      expect(result.checks.state).toBe("partial");
      expect(
        currentMergeChecks(result).some((c) => c.status === "in_progress"),
      ).toBe(true);
      store.tracking.observe(tracked.id, result, config);
      if (round === 0) {
        store.close();
        store = new Store(directory);
      }
    }
    expect(seen.has(1025)).toBe(true);
    expect(seen.size).toBe(25);
    expect(store.tracking.checks.list(tracked.id).at(-1)?.state).toBe(
      CheckWatchState.Waiting,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lineage survives wire/storage roundtrips and only proves same-run later-attempt replacement", () => {
  const enriched = { ...old(1), workflowRunId: 9, workflowRunAttempt: 1 };
  const evidence = { state: "complete" as const, value: [enriched] };
  expect(
    unwire(
      DomainCheckEvidenceSchema,
      wire(DomainCheckEvidenceSchema, evidence),
    ),
  ).toEqual(evidence);
  expect(storedCheckEvidence(evidence)).toEqual(evidence);
  const legacy = { state: "complete", value: [old(1)] };
  expect(
    unwire(DomainCheckEvidenceSchema, wire(DomainCheckEvidenceSchema, legacy)),
  ).toEqual(legacy);
  const halfPair = {
    state: "complete",
    value: [{ ...old(1), workflowRunId: 9 }],
  };
  expect(() =>
    storedCheckEvidence(
      unwire(
        DomainCheckEvidenceSchema,
        wire(DomainCheckEvidenceSchema, halfPair),
      ),
    ),
  ).toThrow("Invalid");
  expect(
    storedCheckEvidence({ state: "complete", value: [old(1)] })?.state,
  ).toBe("complete");
  expect(checkReplaces(enriched, workflow)).toBe(true);
  for (const candidate of [
    { ...workflow, id: "workflow:10:2" },
    { ...workflow, id: "workflow:9:1" },
    { ...workflow, headSha: "other" },
    old(2),
  ])
    expect(checkReplaces(enriched, candidate)).toBe(false);
  for (const invalid of [
    { ...old(1), workflowRunId: 9 },
    { ...old(1), workflowRunAttempt: 1 },
    { ...enriched, workflowRunAttempt: 0 },
    { ...enriched, workflowRunId: NaN },
  ]) {
    expect(() =>
      storedCheckEvidence({ state: "complete", value: [invalid] }),
    ).toThrow("Invalid");
    expect(checkReplaces(invalid, workflow)).toBe(false);
  }
});

test("late head changes still reject a reconciled observation", async () => {
  const read = source(job);
  let reads = 0;
  await rejects(
    readObservation(
      url,
      undefined,
      async (path) => {
        if (/\/pulls\/1$/u.test(path)) {
          reads++;
          return reads === 1 ? pr : { ...pr, head: { sha: "changed" } };
        }
        return read(path);
      },
      Date.now,
      undefined,
      { checks: [old(2)] },
    ),
    GitHubObservationChangedError,
  );
});

test("auxiliary rate limits propagate and later failed workflows remain failed", async () => {
  const rateLimit = new GitHubRateLimitError(Date.now() + 60000);
  await rejects(
    readObservation(
      url,
      undefined,
      source(() => {
        throw rateLimit;
      }),
      Date.now,
      undefined,
      { checks: [old(2)] },
    ),
    rateLimit,
  );
  const read = source(job);
  const result = await readObservation(
    url,
    undefined,
    async (path) => {
      if (path.includes("/actions/runs"))
        return {
          workflow_runs: [
            {
              id: 9,
              run_attempt: 2,
              name: "CI",
              head_sha: "head",
              status: "completed",
              conclusion: "failure",
              html_url: url,
            },
          ],
        };
      return read(path);
    },
    Date.now,
    undefined,
    { checks: [old(1, "failure")] },
  );
  expect(
    currentMergeChecks(result).map((check) => [check.id, check.conclusion]),
  ).toEqual([["workflow:9:2", "failure"]]);
});

test("same-named current checks cannot hide unknown execution from another run", async () => {
  const checks = [
    old(2),
    { ...old(3, "success"), key: old(2).key, name: old(2).name, at: 2000 },
  ];
  const directory = await mkdtemp(join(tmpdir(), "octo-check-same-name-"));
  const store = new Store(directory);
  try {
    const tracked = store.tracking.track(url, target);
    store.tracking.observe(
      tracked.id,
      observation(checks, [workflow]),
      defaultTrackingConfig(),
    );
    const observed = store.tracking.pr(tracked.id).observation;
    if (observed === undefined) throw new Error("Missing observation");
    expect(currentChecks(observed).map((check) => check.id)).toEqual([
      "run:2",
      "run:3",
    ]);
    expect(store.tracking.checks.list(tracked.id).at(-1)?.state).toBe(
      CheckWatchState.Waiting,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refresh reconciles a returning head against its superseded watch before readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-return-head-"));
  const store = new Store(directory);
  const config = defaultTrackingConfig();
  const tracked = store.tracking.track(url, target);
  try {
    store.tracking.observe(tracked.id, observation([old(1)]), config);
    store.tracking.observe(
      tracked.id,
      { ...observation([]), headSha: "other-head" },
      config,
    );
    expect(store.tracking.checks.list(tracked.id)[0]?.state).toBe(
      CheckWatchState.Superseded,
    );
    const requests: number[] = [];
    let resolved = false;
    const service = new TrackingService(store.tracking, config, Date.now, {
      read: (address, signal, _read, now, _metadata, retained) =>
        readObservation(
          address,
          signal,
          source((id) => {
            if (!resolved) throw new Error("404");
            return job(id);
          }, requests),
          now,
          undefined,
          retained,
        ),
    });
    try {
      await service.refresh(tracked.id);
      const first = store.tracking.pr(tracked.id).observation;
      if (first === undefined) throw new Error("Missing observation");
      expect(first.headSha).toBe("head");
      expect(first.checks.state).toBe("partial");
      expect(
        currentMergeChecks(first).some(
          (check) => check.id === "run:1" && check.status === "in_progress",
        ),
      ).toBe(true);
      expect(store.tracking.checks.list(tracked.id).at(-1)?.state).toBe(
        CheckWatchState.Waiting,
      );
      expect(requests).toEqual([1001]);
      resolved = true;
      await service.refresh(tracked.id);
      const repaired = store.tracking.pr(tracked.id).observation;
      if (repaired === undefined) throw new Error("Missing observation");
      expect(repaired.checks.state).toBe("complete");
      expect(currentMergeChecks(repaired).map((check) => check.id)).toEqual([
        workflow.id,
      ]);
      expect(store.tracking.checks.list(tracked.id).at(-1)?.state).toBe(
        CheckWatchState.Completed,
      );
    } finally {
      await service.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified old jobs do not complete a pending or partially observed later attempt", async () => {
  for (const partial of [false, true]) {
    const read = source(job);
    const latest = {
      id: 9,
      run_attempt: 2,
      name: "CI",
      head_sha: "head",
      status: partial ? "completed" : "in_progress",
      conclusion: partial ? "success" : null,
      html_url: url,
    };
    const result = await readObservation(
      url,
      undefined,
      async (path) => {
        if (path.includes("/actions/runs")) {
          if (partial && path.includes("page=2"))
            throw new Error("later page unavailable");
          return {
            workflow_runs: partial
              ? Array.from({ length: 100 }, () => latest)
              : [latest],
          };
        }
        return read(path);
      },
      Date.now,
      undefined,
      { checks: [old(1, "failure")] },
    );
    expect(result.workflows?.state).toBe(partial ? "partial" : "complete");
    const evidence = checkEvidence({ ...result, id: 1, prId: "test" });
    expect(
      evidence.state === "unavailable"
        ? []
        : evidence.value.map((check) => check.id),
    ).toEqual([workflow.id]);
    expect(checksFinished(evidence)).toBe(false);
  }
});

test("unchanged same-key failed jobs preserve action and delivery identities across refreshes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "octo-check-failure-actions-"),
  );
  const store = new Store(directory);
  const config = defaultTrackingConfig();
  const tracked = store.tracking.track(url, target);
  const read = source(job);
  const checks = [1, 2].map((id) => ({
    id,
    name: "shared job",
    head_sha: "head",
    app: { id: 1 },
    status: "completed",
    conclusion: "failure",
    html_url: `${url}#${String(id)}`,
  }));
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: (address, signal, _read, now, _metadata, retained) =>
      readObservation(
        address,
        signal,
        async (path) => {
          if (path.includes("/check-runs")) return { check_runs: checks };
          return read(path);
        },
        now,
        undefined,
        retained,
      ),
  });
  try {
    await service.refresh(tracked.id);
    const actions = store.tracking.actions();
    const deliveries = store.tracking.deliveries();
    expect(
      actions.filter((action) => action.blocker.kind === "check_failed"),
    ).toHaveLength(2);
    for (let refresh = 0; refresh < 3; refresh++) {
      await service.refresh(tracked.id);
      expect(store.tracking.actions()).toEqual(actions);
      expect(store.tracking.deliveries()).toEqual(deliveries);
    }
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure actions require exact success or verified replacement using opening evidence", async () => {
  for (const kind of [
    "status",
    "workflow",
    "unrelated",
    "exact",
    "partial",
  ] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), "octo-check-action-replacement-"),
    );
    const store = new Store(directory);
    const config = defaultTrackingConfig();
    const tracked = store.tracking.track(url, target);
    const failed =
      kind === "status"
        ? {
            ...old(1, "failure"),
            id: "status:1",
            key: "status:ci",
            status: "failure",
          }
        : { ...old(1, "failure"), workflowRunId: 9, workflowRunAttempt: 1 };
    try {
      store.tracking.observe(tracked.id, observation([failed]), config);
      const action = store.tracking
        .actions()
        .find((value) => value.blocker.kind === "check_failed");
      if (action === undefined) throw new Error("Missing failure action");
      const replacement =
        kind === "status"
          ? {
              ...failed,
              id: "status:2",
              status: "success",
              conclusion: "success",
            }
          : kind === "exact" || kind === "partial"
            ? { ...failed, conclusion: "success" }
            : { ...old(2, "success"), key: failed.key };
      store.tracking.observe(
        tracked.id,
        kind === "workflow"
          ? observation([], [workflow])
          : kind === "partial"
            ? {
                ...observation([replacement]),
                checks: {
                  state: "partial",
                  value: [replacement],
                  reason: "Incomplete coverage",
                },
              }
            : observation([replacement]),
        config,
      );
      expect(store.tracking.action(action.id).progress.state).toBe(
        kind === "unrelated" || kind === "partial"
          ? ActionState.Open
          : kind === "exact"
            ? ActionState.Resolved
            : ActionState.Superseded,
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
