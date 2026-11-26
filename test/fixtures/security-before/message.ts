// Historical notification rendering from 3142760ac951c667bde382044d1814cbdec3a682:src/tracking/messages.ts.
// Rendering functions are preserved; shared pure helpers use the current source tree.
import { feedbackExcerpt } from "../../../src/tracking/review-signals.js";
import { shortId } from "../../../src/tracking/identifiers.js";
import { stripVTControlCharacters } from "node:util";
import type { Action } from "../../../src/tracking/types.js";
import { successfulCheck } from "../../../src/tracking/checks.js";
export function compact(value: string, limit: number): string {
  const clean = Array.from(stripVTControlCharacters(value))
    .filter(
      (character) =>
        character === "\n" || character === "\t" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .join("")
    .trim();
  if (Buffer.byteLength(clean) <= limit) return clean;
  let text = "";
  for (const point of clean) {
    if (Buffer.byteLength(text + point) > limit - 3) break;
    text += point;
  }
  return text + "…";
}
function link(label: string, url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.href.length > 512)
      return label;
    return `[${label}](${parsed.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  } catch {
    return label;
  }
}
export function agentMessage(
  action: Action,
  prUrl: string,
  deliveryId: string,
  excerpt?: string,
  identities: { actions: string[]; messages: string[] } = {
    actions: [],
    messages: [],
  },
): string {
  const blocker = action.blocker;
  const head =
    blocker.kind === "changes_requested"
      ? blocker.reviewedHeadSha
      : blocker.kind === "review_feedback"
        ? blocker.feedback.headSha
        : blocker.headSha;
  const failed = blocker.kind === "check_results" ? blocker.checks.find((check) => !successfulCheck(check)) : undefined;
  const body = blocker.kind === "review_feedback" ? feedbackExcerpt(blocker.feedback) : excerpt;
  const detail =
    body === undefined
      ? ""
      : compact(body, 480)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n";
  const location =
    blocker.kind === "review_feedback" && blocker.feedback.path !== undefined
      ? ` · ${compact(blocker.feedback.path.replace(/\s+/g, " "), 120)}${blocker.feedback.line === undefined ? "" : `:${String(blocker.feedback.line)}`}`
      : "";
  const evidence = failed?.url ?? action.evidenceUrl;
  const completion = blocker.kind === "check_results" && failed === undefined;
  return `[octo-delivery:${shortId(deliveryId, identities.messages)}]\n${link(`PR #${new URL(prUrl).pathname.split("/").at(-1) ?? ""}`, prUrl)} · ${compact(action.summary.replace(/\s+/g, " "), 120)}${head === undefined ? "" : ` at ${compact(head.replace(/\s+/g, " "), 200).slice(0, 8)}`}${location}\n${detail}${completion ? "" : link(blocker.kind === "check_failed" || blocker.kind === "check_results" ? "Failed run" : "Evidence", evidence) + "\n"}Action: ${shortId(action.id, identities.actions)}`;
}
