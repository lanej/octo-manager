import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { readObservation } from "../src/tracking/github.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import { ActionState, DeliveryState } from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
function github() {
  let body = "Please use the existing parser.";
  let offline = false;
  let line: number | null = 42;
  const read = (path: string): Promise<unknown> => {
    if (path.endsWith("/pulls/1"))
      return Promise.resolve({
        state: "open",
        merged: false,
        mergeable: true,
        head: { sha: "head" },
        base: { sha: "base", ref: "main", repo: { private: true } },
      });
    if (path.includes("/git/ref/"))
      return Promise.resolve({ object: { sha: "base" } });
    if (path.includes("check-runs")) return Promise.resolve({ check_runs: [] });
    if (path.includes("/reviews?"))
      return Promise.resolve([
        {
          id: 1,
          user: { login: "reviewer" },
          state: "COMMENTED",
          body: "Please simplify this.",
          html_url: `${url}#pullrequestreview-1`,
          commit_id: "reviewed-head",
        },
        {
          id: 2,
          user: { login: "reviewer" },
          state: "PENDING",
          body: "Private draft",
        },
      ]);
    if (path.includes("/pulls/1/comments?"))
      return Promise.resolve([
        {
          id: 3,
          user: { login: "review-bot[bot]" },
          body,
          html_url: "https://github.com/Owner/Repo/pull/1#discussion_r3",
          commit_id: "reviewed-head",
          path: "src/parser.ts",
          line,
          pull_request_review_id: 1,
        },
        {
          id: 4,
          user: { login: "reviewer" },
          body: "Draft inline",
          html_url: `${url}#discussion_r4`,
          commit_id: "head",
          path: "src/parser.ts",
          line: null,
          pull_request_review_id: 2,
        },
      ]);
    if (path.includes("/issues/1/comments?")) {
      if (offline) return Promise.reject(new Error("offline"));
      return Promise.resolve([
        {
          id: 5,
          user: { login: "colleague" },
          body: "Could we document the behavior?",
          html_url: `${url}#issuecomment-5`,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return {
    read,
    edit: () => {
      body = "Please keep the existing parser and add context.";
    },
    move: () => {
      line = null;
    },
    disconnect: () => {
      offline = true;
    },
  };
}

test("review, inline and conversation feedback is durable, deduplicated, delivered to the owner and revised without claiming resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-feedback-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  config.profiles["review_feedback"] = {
    name: "review_feedback",
    instructions: "Classify simple feedback before proposing work.",
    harness: "future-harness",
    model: "cheap-model",
  };
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  const source = github();
  const observed = await readObservation(url, undefined, source.read);
  const sent: string[] = [];
  let service = new TrackingService(store.tracking, config, Date.now, {
    read: () => Promise.resolve(observed),
    connect: (agent) => {
      assert.equal(agent.sessionId, "owner");
      return {
        prepare: () => Promise.resolve({ busy: false }),
        send: (_agent, _id, message) => {
          sent.push(message);
          return Promise.resolve({ queueId: "receipt" });
        },
        find: () => Promise.resolve({ found: false }),
        close: () => {},
      };
    },
  });
  try {
    store.tracking.observe(pr.id, observed, config);
    store.tracking.observe(pr.id, observed, config);
    assert.equal(store.tracking.actions().length, 3);
    assert(
      !JSON.stringify(store.tracking.snapshot()).includes("Private draft"),
    );
    for (let i = 0; i < 100 && sent.length < 3; i++) {
      service.tick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sent.length, 3);
    assert(
      sent.some(
        (message) =>
          message.includes("src/parser.ts") &&
          message.includes("42") &&
          message.includes("discussion_r3") &&
          message.includes("existing parser"),
      ),
    );
    assert(
      sent.every(
        (message) =>
          message.includes("cheap-model") &&
          message.includes("triage and reporting only"),
      ),
    );
    assert(
      store.tracking
        .actions()
        .every((action) => action.progress.state === ActionState.Open),
    );
    assert(
      store.tracking
        .deliveries()
        .every(
          (delivery) => delivery.progress.state === DeliveryState.Delivered,
        ),
    );
    await service.close();
    const original = store.tracking
      .actions()
      .find(
        (action) =>
          action.blocker.kind === "review_feedback" &&
          action.blocker.feedback.source === "inline",
      );
    assert(original !== undefined);
    store.tracking.progress(original.id, pr.ownerAgentId, false);
    const identity = store.instanceId();
    store.close();
    // Simulate an existing v5 database, including durable actions, receipts and acknowledgment.
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.exec(
      "DROP TRIGGER immutable_message_recipient; DROP TABLE delivery_messages; ALTER TABLE pr_observations DROP COLUMN feedback_json; PRAGMA user_version=5",
    );
    db.close();
    store = new Store(directory);
    assert.equal(store.instanceId(), identity);
    assert.equal(
      store.tracking.action(original.id).progress.state,
      ActionState.Acknowledged,
    );
    assert.equal(store.tracking.attempts().length, 3);
    store.tracking.observe(pr.id, observed, config);
    assert.equal(store.tracking.actions().length, 3);
    source.move();
    store.tracking.observe(
      pr.id,
      await readObservation(url, undefined, source.read),
      config,
    );
    assert.equal(store.tracking.actions().length, 3);
    source.edit();
    const edited = await readObservation(url, undefined, source.read);
    store.tracking.observe(pr.id, edited, config);
    assert.equal(store.tracking.actions().length, 4);
    assert.equal(
      store.tracking.action(original.id).progress.state,
      ActionState.Superseded,
    );
    source.disconnect();
    const partial = await readObservation(url, undefined, source.read);
    assert.equal(partial.feedback?.state, "partial");
    store.tracking.observe(pr.id, partial, config);
    assert.equal(store.tracking.actions().length, 4);
    const fresh = store.tracking
      .actions()
      .find(
        (action) =>
          action.blocker.kind === "review_feedback" &&
          action.blocker.feedback.body.includes("add context"),
      );
    assert(fresh !== undefined);
    assert.equal(fresh.progress.state, ActionState.Open);
    store.tracking.observe(pr.id, { ...edited, headSha: "new-head" }, config);
    assert.equal(
      store.tracking.action(fresh.id).progress.state,
      ActionState.Open,
    );
    service = new TrackingService(store.tracking, config);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
