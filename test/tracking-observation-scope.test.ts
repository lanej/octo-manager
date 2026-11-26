import { expect, spyOn, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { CheckWatchState } from "../src/tracking/checks.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  ActionState,
  type CheckObservation,
  type ObservationInput,
} from "../src/tracking/types.js";

test("observing one PR does not decode unrelated action history while closing conflicts and completing checks", async () => {
  const directory = await mkdtemp("/tmp/octo-observation-scope-");
  const store = new Store(directory, () => 1000);
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  const config = defaultTrackingConfig();
  const head = "a".repeat(40),
    url = "https://github.com/owner/repo/pull/1";
  const check: CheckObservation = {
    id: "run:1",
    key: "ci",
    name: "CI",
    headSha: head,
    status: "in_progress",
    conclusion: "",
    at: 1000,
    url,
  };
  const observation: ObservationInput = {
    observedAt: 1000,
    headSha: head,
    baseSha: "b".repeat(40),
    lifecycle: "open",
    mergeability: "conflicting",
    checks: { state: "complete", value: [check] },
    workflows: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  try {
    const owner = {
      harness: "codex",
      endpoint: "local",
      sessionId: "scoped-observation",
    };
    const selected = store.tracking.track(url, owner);
    const unrelated = store.tracking.track(
      "https://github.com/owner/repo/pull/2",
      owner,
    );
    store.tracking.observe(selected.id, observation, config);
    store.tracking.observe(
      unrelated.id,
      {
        ...observation,
        mergeability: "mergeable",
        checks: {
          state: "complete",
          value: Array.from({ length: 100 }, (_, index) => ({
            ...check,
            id: `other:${String(index)}`,
            key: `ci-${String(index)}`,
            name: `Other CI ${String(index)}`,
            status: "completed",
            conclusion: "failure",
          })),
        },
      },
      config,
    );
    expect(store.tracking.actions(unrelated.id).length).toBeGreaterThanOrEqual(
      100,
    );
    const conflict = store.tracking
      .actions(selected.id)
      .find((action) => action.blocker.kind === "conflict");
    if (conflict === undefined) throw new Error("Missing initial conflict");
    const marker = "unrelated-action-profile-that-must-not-be-decoded";
    db.prepare(
      "UPDATE actions SET profile_json=json_set(profile_json,'$.instructions',?) WHERE pr_id=?",
    ).run(marker, unrelated.id);
    const completed: ObservationInput = {
      ...observation,
      observedAt: 2000,
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [{ ...check, status: "completed", conclusion: "success" }],
      },
    };
    const parse = spyOn(JSON, "parse");
    try {
      store.tracking.observe(selected.id, completed, config);
      store.tracking.observe(
        selected.id,
        { ...completed, observedAt: 3000 },
        config,
      );
      expect(
        parse.mock.calls.filter(([text]) => text.includes(marker)),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
    expect(store.tracking.action(conflict.id).progress.state).toBe(
      ActionState.Resolved,
    );
    const actions = store.tracking.actions(selected.id);
    expect(
      actions.filter((action) => action.blocker.kind === "check_results"),
    ).toHaveLength(1);
    expect(
      store.tracking.checks.list(selected.id).map((watch) => watch.state),
    ).toEqual([CheckWatchState.Completed]);
    expect(store.tracking.pr(selected.id).observation?.observedAt).toBe(3000);
    expect(
      store.tracking
        .actions(unrelated.id)
        .filter((action) => action.progress.state === ActionState.Open).length,
    ).toBeGreaterThanOrEqual(100);
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
