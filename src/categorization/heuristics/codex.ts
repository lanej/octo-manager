import {
  MessageCategory,
  type GitHubMessage,
  type HeuristicClassifier,
  type CategoryDecision,
} from "../types.js";
export const codexAuthor = "chatgpt-codex-connector[bot]";
export function isCodexSummary(message: GitHubMessage): boolean {
  return (
    message.author.toLowerCase() === codexAuthor &&
    message.source !== "inline" &&
    message.body.includes("<!-- codex-pull-request-review-summary -->")
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const progress = new Set(["pending", "queued", "running", "in_progress"]);
const inconclusive = new Set(["inconclusive", "cancelled", "failed", "error"]);
const finished = new Set(["completed", "skipped"]);
function decision(
  category: MessageCategory,
  rule: string,
  reason: string,
): CategoryDecision {
  return { category, rule, reason };
}
export const codexHeuristic: HeuristicClassifier = {
  id: "codex-review-state",
  version: 2,
  categorize(message) {
    const unknown = () =>
      decision(
        MessageCategory.Unknown,
        "unrecognized-state",
        "No recognized Codex review-state evidence",
      );
    if (
      message.author.toLowerCase() !== codexAuthor ||
      message.source === "inline"
    )
      return unknown();
    if (message.body.includes("<!-- codex-code-review-finding:v1 -->"))
      return decision(
        MessageCategory.Findings,
        "finding-body",
        "Codex message contains an actual review finding",
      );
    if (message.body.includes("<!-- codex-review-receipt:v1 -->")) {
      const text = message.body
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(
          /<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*?<\/details>/gu,
          "",
        )
        .replace(/\s+/gu, " ")
        .trim();
      if (
        /^### 💡 Codex Review Here are some automated review suggestions for this pull request\. \*\*Reviewed commit:\*\* `[a-f0-9]{7,40}`$/u.test(
          text,
        )
      )
        return decision(
          MessageCategory.Informational,
          "review-receipt",
          "Review receipt contains no finding details",
        );
      return unknown();
    }
    if (!isCodexSummary(message)) return unknown();
    const match = /<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/.exec(
      message.body,
    );
    if (match?.[1] === undefined) return unknown();
    let state: unknown;
    try {
      state = JSON.parse(match[1]);
    } catch {
      return unknown();
    }
    if (!object(state)) return unknown();
    const entries = [state["code_review"], state["security_review"]].filter(
      (entry) => entry !== undefined,
    );
    if (entries.length === 0) return unknown();
    const hasFindings = entries.some(
      (entry) =>
        object(entry) &&
        (entry["has_any_findings"] === true ||
          entry["has_unresolved_findings"] === true),
    );
    let pending = false,
      uncertain = false;
    for (const entry of entries) {
      if (!object(entry) || typeof entry["status"] !== "string")
        return unknown();
      const status = entry["status"];
      if (
        !progress.has(status) &&
        !inconclusive.has(status) &&
        !finished.has(status)
      )
        return unknown();
      for (const key of ["has_any_findings", "has_unresolved_findings"])
        if (entry[key] !== true && entry[key] !== false && entry[key] !== null)
          return unknown();
      pending ||= progress.has(status);
      uncertain ||=
        inconclusive.has(status) ||
        (finished.has(status) &&
          (entry["has_any_findings"] === null ||
            entry["has_unresolved_findings"] === null));
    }
    if (hasFindings)
      return decision(
        MessageCategory.Informational,
        "findings-summary",
        "Status summary reports findings delivered separately as review comments",
      );
    if (uncertain)
      return decision(
        MessageCategory.Inconclusive,
        "inconclusive-review",
        "A review has no conclusive finding result",
      );
    if (pending)
      return decision(
        MessageCategory.Progress,
        "review-in-progress",
        "A review is queued or running without findings",
      );
    return decision(
      MessageCategory.NoFindings,
      "completed-no-findings",
      "All reported reviews completed without findings",
    );
  },
};
