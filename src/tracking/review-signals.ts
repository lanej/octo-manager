import type { ReviewFeedback } from "./types.js";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const lifecycle = new Set([
  "pending",
  "queued",
  "running",
  "in_progress",
  "inconclusive",
  "completed",
  "cancelled",
  "skipped",
  "failed",
  "error",
]);
function codexSummary(feedback: ReviewFeedback): boolean {
  return (
    feedback.author === "chatgpt-codex-connector[bot]" &&
    feedback.source !== "inline" &&
    feedback.body.includes("<!-- codex-pull-request-review-summary -->")
  );
}
export function actionableFeedback(feedback: ReviewFeedback): boolean {
  if (codexSummary(feedback)) {
    const match = /<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/.exec(
      feedback.body,
    );
    if (match?.[1] === undefined) return true;
    let state: unknown;
    try {
      state = JSON.parse(match[1]);
    } catch {
      return true;
    }
    if (!object(state)) return true;
    const entries = [state["code_review"], state["security_review"]].filter(
      (entry) => entry !== undefined,
    );
    if (entries.length === 0) return true;
    for (const entry of entries) {
      if (
        !object(entry) ||
        typeof entry["status"] !== "string" ||
        !lifecycle.has(entry["status"])
      )
        return true;
      if (
        entry["has_any_findings"] === true ||
        entry["has_unresolved_findings"] === true
      )
        return true;
      if (
        (entry["has_any_findings"] !== false &&
          entry["has_any_findings"] !== null) ||
        (entry["has_unresolved_findings"] !== false &&
          entry["has_unresolved_findings"] !== null)
      )
        return true;
    }
    return false;
  }
  if (
    ["copilot-pull-request-reviewer[bot]", "Copilot"].includes(
      feedback.author,
    ) &&
    feedback.source !== "inline"
  ) {
    const visible = feedback.body.replace(/<!--[^]*?-->/g, "").trim();
    if (
      feedback.body.includes("<!-- ccr-overview-v2 -->") &&
      /^###\s+(?:🟢\s*)?Approval recommended\s*\n+(?:[^\n]+ (?:have|has) no active review issues\.\s*\n+)?\*\*No open issues\*\*(?:\s*🎉)?\s*(?:<details>\s*<summary>\s*<strong>What changed in this PR<\/strong>\s*<\/summary>[\s\S]*?<\/details>\s*)?(?:<sub>Review effort: [A-Za-z ]+<\/sub>)?$/iu.test(
        visible,
      )
    )
      return false;
    if (
      /^Copilot reviewed \d+ out of \d+ changed files(?: in this pull request)? and generated (?:\*\*)?0(?:\*\*)? comments\.?$/i.test(
        visible,
      )
    )
      return false;
    if (
      /^Copilot (?:is reviewing this pull request|review is (?:queued|running|inconclusive))\.?$/i.test(
        visible,
      )
    )
      return false;
  }
  return true;
}
export function feedbackExcerpt(feedback: ReviewFeedback): string {
  return codexSummary(feedback)
    ? feedback.body.replace(/^(?:\s*<!--[\s\S]*?-->)+\s*/, "")
    : feedback.body;
}
