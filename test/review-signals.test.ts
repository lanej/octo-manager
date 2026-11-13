import { test, spyOn } from "bun:test";
import * as reviewSignals from "../src/tracking/review-signals.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  actionableFeedback,
  feedbackExcerpt,
} from "../src/tracking/review-signals.js";
import { feedbackRevision } from "../src/tracking/feedback.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
  type ReviewFeedback,
} from "../src/tracking/types.js";
const url = "https://github.com/owner/repo/pull/1";
function codex(
  status: string,
  findings: boolean | null = null,
): ReviewFeedback {
  return feedbackRevision({
    source: "conversation",
    id: "summary",
    author: "chatgpt-codex-connector[bot]",
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status, has_any_findings: findings, has_unresolved_findings: findings }, security_review: { status: "running", has_any_findings: null, has_unresolved_findings: null } })} -->\nReview summary`,
    url,
  });
}
function copilot(body: string): ReviewFeedback {
  return feedbackRevision({
    source: "review",
    id: "copilot",
    author: "copilot-pull-request-reviewer[bot]",
    body,
    url,
  });
}
const observation = (feedback: ReviewFeedback[]): ObservationInput => ({
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  workflows: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
  feedback: { state: "complete", value: feedback },
});
test("known review lifecycle and no-findings summaries stay quiet while real and unknown feedback remain actionable", () => {
  for (const status of ["queued", "running", "inconclusive", "completed"]) {
    assert.equal(actionableFeedback(codex(status)), false);
    assert.equal(actionableFeedback(codex(status, false)), false);
    assert.equal(actionableFeedback(codex(status, true)), false);
  }
  assert.equal(
    actionableFeedback(
      copilot(
        "<!-- ccr-overview-v2 -->\n### 🟢 Approval recommended\n\n**No open issues** 🎉\n<details>\n<summary><strong>What changed in this PR</strong></summary>Changes</details>",
      ),
    ),
    false,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "Copilot reviewed 10 out of 10 changed files and generated 0 comments.",
      ),
    ),
    false,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "Copilot reviewed 10 out of 10 changed files and generated 0 comments.\nP1: fix the data-loss race.",
      ),
    ),
    true,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "<!-- ccr-overview-v2 -->\n### 🟢 Approval recommended\n**No open issues**\nP1: fix the data-loss race.",
      ),
    ),
    true,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "<!-- ccr-overview-v2 -->\n### 🟢 Approval recommended\n**No open issues**\n<details><summary>Findings</summary>P1: data loss</details>",
      ),
    ),
    true,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "Copilot reviewed 10 out of 10 changed files and generated 2 comments.",
      ),
    ),
    true,
  );
  assert.equal(
    actionableFeedback(
      copilot(
        "<!-- ccr-overview-v2 -->\n### Changes requested\n**2 open issues**",
      ),
    ),
    true,
  );
  assert.equal(
    actionableFeedback({ ...codex("running"), author: "human" }),
    true,
  );
  assert.equal(
    actionableFeedback({ ...codex("running"), source: "inline" }),
    true,
  );
  assert.equal(
    actionableFeedback({
      ...codex("running"),
      body: "Please fix the running-state race.",
    }),
    true,
  );
  assert.equal(
    actionableFeedback({
      ...codex("running"),
      body: "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 invalid -->",
    }),
    true,
  );
  assert.equal(actionableFeedback(codex("new-unknown-state")), true);
  assert.equal(feedbackExcerpt(codex("completed", true)), "Review summary");
});
test("status edits remain raw observations without actions, and later findings create one durable delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-review-status-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    for (const status of ["running", "inconclusive", "completed"])
      store.tracking.observe(
        pr.id,
        observation([codex(status, false)]),
        config,
      );
    assert.equal(store.tracking.actions().length, 0);
    assert.equal(store.tracking.deliveries().length, 0);
    assert.equal(
      store.tracking.pr(pr.id).observation?.feedback?.state,
      "complete",
    );
    const findings = feedbackRevision({
      ...codex("completed", true),
      source: "inline",
      body: "Fix the data-loss race. <!-- codex-code-review-finding:v1 -->",
    });
    store.tracking.observe(pr.id, observation([findings]), config);
    store.tracking.observe(pr.id, observation([findings]), config);
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(store.tracking.deliveries().length, 1);
    store.close();
    store = new Store(directory);
    store.tracking.observe(pr.id, observation([findings]), config);
    assert.equal(store.tracking.actions().length, 1);
    const action = store.tracking.actions()[0];
    assert(action !== undefined);
    store.tracking.observe(
      pr.id,
      observation([codex("completed", false)]),
      config,
    );
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Open,
    );
    assert.equal(store.tracking.actions().length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const noise of [
  codex("running"),
  codex("completed", true),
  feedbackRevision({
    ...codex("completed"),
    source: "review",
    body: "<!-- codex-review-receipt:v1 -->\n### 💡 Codex Review\nHere are some automated review suggestions for this pull request.\n**Reviewed commit:** `43c2b47359`\n<details><summary>ℹ️ About Codex in GitHub</summary>Help text</details>",
  }),
]) {
  test(`restart retires queued Codex noise: ${noise.body.slice(0, 60)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-review-legacy-"));
    let store = new Store(directory);
    const config = defaultTrackingConfig();
    const pr = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    try {
      const legacy = spyOn(reviewSignals, "actionableFeedback").mockReturnValue(
        true,
      );
      try {
        store.tracking.observe(pr.id, observation([noise]), config);
      } finally {
        legacy.mockRestore();
      }
      const action = store.tracking.actions()[0],
        delivery = store.tracking.deliveries()[0];
      assert(action !== undefined && delivery !== undefined);
      store.tracking.inbox.record(delivery.id, "Historical lifecycle message");
      store.close();
      store = new Store(directory);
      assert.equal(
        store.tracking.action(action.id).progress.state,
        ActionState.Superseded,
      );
      assert.equal(
        store.tracking.deliveries()[0]?.progress.state,
        DeliveryState.Cancelled,
      );
      assert.equal(
        store.tracking.inbox.get(delivery.id)?.body,
        "Historical lifecycle message",
      );
      assert.equal(store.tracking.inbox.get(delivery.id)?.applicable, false);
      assert.equal(
        store.tracking.pr(pr.id).observation?.feedback?.state,
        "complete",
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Codex receipts suppress boilerplate but preserve extra findings and other authors", () => {
  const receipt = feedbackRevision({
    ...codex("completed"),
    source: "review",
    body: "<!-- codex-review-receipt:v1 -->\n### 💡 Codex Review\nHere are some automated review suggestions for this pull request.\n**Reviewed commit:** `43c2b47359`\n<details><summary>ℹ️ About Codex in GitHub</summary>Help text</details>",
  });
  assert.equal(actionableFeedback(receipt), false);
  assert.equal(
    actionableFeedback({
      ...receipt,
      body:
        receipt.body +
        "\n<details><summary>P1 finding</summary>Fix data loss.</details>",
    }),
    true,
  );
  assert.equal(actionableFeedback({ ...receipt, author: "human" }), true);
  assert.equal(actionableFeedback({ ...receipt, source: "inline" }), true);
  assert.equal(
    actionableFeedback({
      ...receipt,
      body: receipt.body + "\nP1: Fix data loss.",
    }),
    true,
  );
  assert.equal(
    actionableFeedback({
      ...codex("completed", true),
      body:
        codex("completed", true).body +
        "\n<!-- codex-code-review-finding:v1 --> Fix the race.",
    }),
    true,
  );
});
