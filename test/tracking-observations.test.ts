import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/coordinator/store.js";
import { SQLiteObservationRepository } from "../src/tracking/observations.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { feedbackRevision, reviewObservation } from "../src/tracking/feedback.js";
import { PRLifecycle, ReviewState, prLifecycle } from "../src/tracking/states.js";
import type { ObservationInput } from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
const initial: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: PRLifecycle.Merged,
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  workflows: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};

test("tracking rolls back observation, actions and deliveries when retirement persistence fails", async () => {
  const directory = await mkdtemp("/tmp/octo-observations-");
  const store = new Store(directory, () => 1000);
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  try {
    const pr = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    store.tracking.observe(pr.id, initial, defaultTrackingConfig());
    const repository = new SQLiteObservationRepository(db);
    const before = repository.latest(pr.id);
    if (before === undefined) throw new Error("Missing initial observation");
    expect(repository.lifecycle(before.id)).toBe(PRLifecycle.Merged);
    const feedback = feedbackRevision({
      source: "inline",
      id: "late",
      author: "owner",
      body: "Use a repository for persistence",
      url: `${url}#discussion_r1`,
    });
    db.exec(
      "CREATE TRIGGER fail_archive BEFORE INSERT ON events WHEN NEW.kind='pr_archived' BEGIN SELECT RAISE(ABORT,'Injected retirement failure'); END",
    );
    expect(() =>
      store.tracking.observe(
        pr.id,
        { ...initial, feedback: { state: "complete", value: [feedback] } },
        defaultTrackingConfig(),
      ),
    ).toThrow("Injected retirement failure");
    expect(repository.latest(pr.id)).toEqual(before);
    expect(store.tracking.actions()).toHaveLength(0);
    expect(store.tracking.deliveries()).toHaveLength(0);
    db.exec("DROP TRIGGER fail_archive");
    store.tracking.observe(
      pr.id,
      { ...initial, feedback: { state: "complete", value: [feedback] } },
      defaultTrackingConfig(),
    );
    expect(store.tracking.actions()).toHaveLength(1);
    expect(store.tracking.deliveries()).toHaveLength(1);
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider and persisted review states reject unsupported values without silently settling", async () => {
  const provider = {
    id: 1,
    user: { login: "owner" },
    commit_id: "head",
    state: ReviewState.Pending,
    html_url: url,
  };
  expect(reviewObservation(provider, url).state).toBe(ReviewState.Pending);
  expect(() => reviewObservation({ ...provider, state: "UNRECOGNIZED" }, url)).toThrow("Invalid review state");
  expect(() => prLifecycle("reopened")).toThrow("Invalid PR lifecycle");
  const directory = await mkdtemp("/tmp/octo-observation-state-");
  const store = new Store(directory, () => 1000);
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  try {
    const pr = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    store.tracking.observe(pr.id, initial, defaultTrackingConfig());
    const repository = new SQLiteObservationRepository(db);
    const persisted: ObservationInput["reviews"] = {
      state: "complete",
      value: [
        {
          id: "review",
          author: "owner",
          headSha: "head",
          state: ReviewState.Commented,
          at: 1000,
          url,
        },
      ],
    };
    db.prepare("UPDATE pr_observations SET reviews_json=? WHERE pr_id=?").run(JSON.stringify(persisted), pr.id);
    expect(repository.latest(pr.id)?.reviews).toEqual(persisted);
    db.prepare("UPDATE pr_observations SET reviews_json=? WHERE pr_id=?").run(
      JSON.stringify({
        ...persisted,
        value: [{ ...persisted.value[0], state: "UNRECOGNIZED" }],
      }),
      pr.id,
    );
    expect(() => repository.latest(pr.id)).toThrow("Invalid review state");
    expect(() => repository.lifecycle(Number.MAX_SAFE_INTEGER)).toThrow("Opening PR observation not found");
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
