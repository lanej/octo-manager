import { feedbackExcerpt } from "./review-signals.js";
import { shortId } from "./identifiers.js";
import { stripVTControlCharacters } from "node:util";
import type { Action } from "./types.js";
import { successfulCheck } from "./checks.js";
import { canonicalPR } from "./github.js";
import { githubReads } from "../github-api.js";
export function compact(value: string, limit: number): string {
  const clean = Array.from(stripVTControlCharacters(value))
    .filter(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
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
export function logExcerpt(log: string): string | undefined {
  const lines = log
    .split("\n")
    .slice(-100)
    .map((line) =>
      compact(
        line.replace(/^.*?\t[^\t]*\t(?:\uFEFF)?\d{4}-\d\d-\d\dT\S+\s*/, ""),
        480,
      ),
    );
  const at = lines.findIndex((line) =>
    /(?:\bError:|\bENOENT:|AssertionError|\(fail\)|\bFAIL\b|error TS\d)/i.test(
      line,
    ),
  );
  if (at < 0) return undefined;
  return compact(lines.slice(at, at + 4).join("\n"), 480);
}
export type ReadFailedLog = (
  repository: string,
  run: string,
  job: string,
  signal: AbortSignal,
) => Promise<string>;
const failedLog: ReadFailedLog = async (repository, _run, job, signal) => {
  const result = await githubReads.raw(
    `repos/${repository}/actions/jobs/${job}/logs`,
    {},
    AbortSignal.any([signal, AbortSignal.timeout(4500)]),
  );
  return result.body;
};
export async function readFailureExcerpt(
  action: Action,
  prUrl: string,
  signal: AbortSignal,
  read: ReadFailedLog = failedLog,
): Promise<string | undefined> {
  if (
    action.blocker.kind !== "check_failed" &&
    action.blocker.kind !== "check_results"
  )
    return undefined;
  const repository = new URL(canonicalPR(prUrl)).pathname
    .split("/")
    .slice(1, 3)
    .join("/");
  const evidence =
    action.blocker.kind === "check_results"
      ? action.blocker.checks.find((check) => !successfulCheck(check))?.url
      : action.evidenceUrl;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(
      evidence ?? "",
    );
  if (
    match?.[1]?.toLowerCase() !== repository ||
    match[2] === undefined ||
    match[3] === undefined
  )
    return undefined;
  try {
    return logExcerpt(await read(repository, match[2], match[3], signal));
  } catch {
    return undefined;
  }
}
function link(label: string, url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.href.length > 512
    )
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
  const failed =
    blocker.kind === "check_results"
      ? blocker.checks.find((check) => !successfulCheck(check))
      : undefined;
  const body =
    blocker.kind === "review_feedback"
      ? feedbackExcerpt(blocker.feedback)
      : excerpt;
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
