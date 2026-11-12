import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  CategorizationEngine,
  shouldNotify,
} from "../src/categorization/engine.js";
import {
  MessageCategory,
  type GitHubMessage,
  type HeuristicClassifier,
} from "../src/categorization/types.js";
const engine = new CategorizationEngine();
function codex(status: string, findings: boolean | null): GitHubMessage {
  return {
    author: "chatgpt-codex-connector[bot]",
    source: "conversation",
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status, has_any_findings: findings, has_unresolved_findings: findings } })} -->`,
  };
}
test("author-routed heuristics produce inspectable categories and delivery policy consumes those categories", () => {
  for (const [message, expected] of [
    [codex("running", null), MessageCategory.Progress],
    [codex("inconclusive", null), MessageCategory.Inconclusive],
    [codex("completed", false), MessageCategory.NoFindings],
    [codex("completed", null), MessageCategory.Inconclusive],
    [codex("running", true), MessageCategory.Findings],
    [codex("future-status", null), MessageCategory.Unknown],
  ] as const) {
    const result = engine.categorize(message);
    assert.equal(result.category, expected);
    assert.equal(result.classifier.id, "codex-review-state");
    assert.equal(result.classifier.version, 1);
    assert.equal(result.classifier.layer, "heuristic");
    assert(result.rule.length > 0 && result.reason.length > 0);
    assert.equal(
      shouldNotify(result),
      expected === MessageCategory.Findings ||
        expected === MessageCategory.Unknown,
    );
  }
  const text =
    "Copilot reviewed 10 out of 10 changed files and generated 0 comments.";
  const copilot: GitHubMessage = {
    author: "copilot-pull-request-reviewer[bot]",
    source: "review",
    body: text,
  };
  assert.equal(engine.categorize(copilot).category, MessageCategory.NoFindings);
  assert.equal(
    engine.categorize({
      ...copilot,
      body: text.replace("0 comments", "2 comments"),
    }).category,
    MessageCategory.Findings,
  );
  assert.equal(
    engine.categorize({ ...copilot, author: "human" }).category,
    MessageCategory.Unknown,
  );
  assert.equal(
    engine.categorize({ ...copilot, source: "inline" }).category,
    MessageCategory.Unknown,
  );
  assert.equal(
    engine.categorize({ ...copilot, body: "Copilot review is inconclusive." })
      .category,
    MessageCategory.Inconclusive,
  );
});
test("engine author registry selects a heuristic without coupling delivery policy to provider implementations", () => {
  let calls = 0;
  const classifier: HeuristicClassifier = {
    id: "example-patterns",
    version: 3,
    categorize: () => {
      calls++;
      return {
        category: MessageCategory.Progress,
        rule: "queued",
        reason: "Example bot is queued",
      };
    },
  };
  const configured = new CategorizationEngine(
    new Map([["example[bot]", classifier]]),
  );
  const message: GitHubMessage = {
    author: "Example[bot]",
    source: "conversation",
    body: "queued",
  };
  const result = configured.categorize(message);
  assert.equal(calls, 1);
  assert.equal(result.classifier.id, "example-patterns");
  assert.equal(result.classifier.version, 3);
  assert.equal(shouldNotify(result), false);
  assert.equal(
    configured.categorize({ ...message, author: "other" }).category,
    MessageCategory.Unknown,
  );
  assert.equal(calls, 1);
});
