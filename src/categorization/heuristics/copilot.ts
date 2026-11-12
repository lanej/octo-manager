import {
  MessageCategory,
  type HeuristicClassifier,
  type CategoryDecision,
} from "../types.js";
function decision(
  category: MessageCategory,
  rule: string,
  reason: string,
): CategoryDecision {
  return { category, rule, reason };
}
function cleanOverview(body: string): boolean {
  let overview = body
    .replace(/\s*<sub>Review effort: [A-Za-z ]+<\/sub>\s*$/i, "")
    .trim();
  const details = overview.indexOf("<details>");
  if (details >= 0) {
    const content = overview.slice(details).trim();
    if (
      !/^<details>\s*<summary>\s*<strong>What changed in this PR<\/strong>\s*<\/summary>/i.test(
        content,
      ) ||
      !content.endsWith("</details>")
    )
      return false;
    if ([...content.matchAll(/<\/?details\b/gi)].length !== 2) return false;
    overview = overview.slice(0, details).trim();
  }
  const lines = overview
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    !["### 🟢 Approval recommended", "### Approval recommended"].includes(
      lines[0] ?? "",
    )
  )
    return false;
  if (
    !["**No open issues**", "**No open issues** 🎉"].includes(
      lines.at(-1) ?? "",
    )
  )
    return false;
  return (
    lines.length === 2 ||
    (lines.length === 3 &&
      /^.+ (?:have|has) no active review issues\.$/i.test(lines[1] ?? ""))
  );
}
export const copilotHeuristic: HeuristicClassifier = {
  id: "copilot-review-patterns",
  version: 1,
  categorize(message) {
    const visible = message.body.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (
      message.body.includes("<!-- ccr-overview-v2 -->") &&
      cleanOverview(visible)
    )
      return decision(
        MessageCategory.NoFindings,
        "clean-overview-v2",
        "Copilot's recognized overview reports no open issues",
      );
    const count =
      /^Copilot reviewed \d+ out of \d+ changed files(?: in this pull request)? and generated (?:\*\*)?(\d+)(?:\*\*)? comments\.?$/i.exec(
        visible,
      )?.[1];
    if (count !== undefined)
      return /^0+$/.test(count)
        ? decision(
            MessageCategory.NoFindings,
            "zero-comments",
            "Copilot generated zero review comments",
          )
        : decision(
            MessageCategory.Findings,
            "review-comments",
            "Copilot reports generated review comments",
          );
    if (/^Copilot review is inconclusive\.?$/i.test(visible))
      return decision(
        MessageCategory.Inconclusive,
        "inconclusive-review",
        "Copilot reports an inconclusive review",
      );
    if (
      /^Copilot (?:is reviewing this pull request|review is (?:queued|running))\.?$/i.test(
        visible,
      )
    )
      return decision(
        MessageCategory.Progress,
        "review-in-progress",
        "Copilot reports review progress",
      );
    return decision(
      MessageCategory.Unknown,
      "unrecognized-pattern",
      "No recognized Copilot message pattern",
    );
  },
};
