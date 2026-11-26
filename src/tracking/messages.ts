import { actionNotice, renderNotice } from "../security/notifications.js";
import { stripVTControlCharacters } from "node:util";
import type { Action } from "./types.js";
import { successfulCheck } from "./checks.js";
import { canonicalPR } from "../github/pr-identity.js";
import { failedStepLogs } from "./job-logs.js";
import { githubReads } from "../github/reads.js";

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

export function logExcerpt(log: string): string | undefined {
  const lines = log
    .split("\n")
    .map((line) => compact(line.replace(/^(?:.*?\t[^\t]*\t)?(?:\uFEFF)?\d{4}-\d\d-\d\dT\S+\s*/, ""), 480));
  const fatal = lines.findIndex((line) => /FATAL ERROR:|heap out of memory/iu.test(line));
  const at =
    fatal >= 0
      ? fatal
      : lines.findIndex((line) => /(?:\bError:|\bENOENT:|AssertionError|\(fail\)|\bFAIL\b|error TS\d)/i.test(line));
  if (at < 0) return undefined;
  return compact(lines.slice(at, at + 4).join("\n"), 480);
}

export type ReadFailedLog = (repository: string, run: string, job: string, signal: AbortSignal) => Promise<string>;
const failedLog: ReadFailedLog = async (repository, run, job, signal) => {
  const bounded = signal;
  const metadata = await githubReads.read(`repos/${repository}/actions/jobs/${job}`, bounded);
  const result = await githubReads.raw(`repos/${repository}/actions/jobs/${job}/logs`, {}, bounded);
  return failedStepLogs(result.body, metadata, { job, run });
};

export async function readFailureExcerpt(
  action: Action,
  prUrl: string,
  signal: AbortSignal,
  read: ReadFailedLog = failedLog,
): Promise<string | undefined> {
  if (action.blocker.kind !== "check_failed" && action.blocker.kind !== "check_results") return undefined;
  const repository = new URL(canonicalPR(prUrl)).pathname.split("/").slice(1, 3).join("/");
  const evidence =
    action.blocker.kind === "check_results"
      ? action.blocker.checks.find((check) => !successfulCheck(check))?.url
      : action.evidenceUrl;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(
    evidence ?? "",
  );
  if (match?.[1]?.toLowerCase() !== repository || match[2] === undefined || match[3] === undefined) return undefined;
  try {
    return logExcerpt(await read(repository, match[2], match[3], signal));
  } catch {
    return undefined;
  }
}

export function agentMessage(
  action: Action,
  prUrl: string,
  deliveryId: string,
  _excerpt?: string,
  identities: { actions: string[]; messages: string[] } = {
    actions: [],
    messages: [],
  },
): string {
  return renderNotice(actionNotice(action, prUrl), deliveryId, action.id, identities);
}
