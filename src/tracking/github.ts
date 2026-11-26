import { canonicalPR } from "../github/pr-identity.js";
import { PRLifecycle, pendingReview, prLifecycle } from "./states.js";
import { commentFeedback, feedbackRevision, reviewObservation } from "./feedback.js";
import {
  checkRunObservation,
  workflowObservation,
  checkReplaces,
  checksFinished,
  type CheckReconciliationContext,
} from "./checks.js";
import { trackingPR } from "./evidence.js";
import { ghRead, GitHubRateLimitError, type ReadGitHub } from "../github/reads.js";
import { githubMetadata } from "./metadata.js";
import type { ObservationInput, ObservationPart, CheckObservation } from "./types.js";
import { GitHubRequestCancelledError } from "../github/errors.js";

export class GitHubObservationChangedError extends Error {
  constructor() {
    super("GitHub PR revisions changed during observation; refresh again");
    this.name = "GitHubObservationChangedError";
  }
}

async function collection<T>(
  path: string,
  field: string | undefined,
  map: (value: unknown) => T,
  read: ReadGitHub,
  signal?: AbortSignal,
): Promise<ObservationPart<T[]>> {
  const items: T[] = [];
  try {
    // WHY: Bounded pagination exposes incomplete evidence instead of clearing blockers from a truncated read.
    for (let page = 1; page <= 10; page++) {
      const raw = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${String(page)}`, signal);
      const values = field === undefined ? raw : record(raw) ? raw[field] : undefined;
      if (!Array.isArray(values)) throw new Error("Invalid GitHub collection");
      items.push(...values.map(map));
      if (values.length < 100) return { state: "complete", value: items };
    }
    return {
      state: "partial",
      value: items,
      reason: "First 1000 records; more may exist",
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return items.length > 0
      ? {
          state: "partial",
          value: items,
          reason: "A later page could not be read",
        }
      : { state: "unavailable", reason: "GitHub collection unavailable" };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function checkReference(value: unknown, root: string, id: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const address = new URL(value);
    return (
      address.protocol === "https:" &&
      address.hostname === "api.github.com" &&
      address.pathname.toLowerCase() === `/${root}/check-runs/${id}`
    );
  } catch {
    return false;
  }
}

async function reconcileCheck(
  check: CheckObservation,
  root: string,
  read: ReadGitHub,
  signal?: AbortSignal,
): Promise<CheckObservation | undefined> {
  const checkId = /^run:([1-9][0-9]*)$/.exec(check.id)?.[1];
  if (checkId === undefined) return undefined;
  let address: URL;
  try {
    address = new URL(check.url);
  } catch {
    return undefined;
  }
  const job = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(address.pathname);
  if (
    address.protocol !== "https:" ||
    address.hostname !== "github.com" ||
    job === null ||
    `repos/${job[1]?.toLowerCase() ?? ""}/${job[2]?.toLowerCase() ?? ""}` !== root
  )
    return undefined;
  const runId = Number(job[3]),
    jobId = Number(job[4]);
  if (!positive(runId) || !positive(jobId)) return undefined;
  try {
    const raw: unknown = await read(`${root}/actions/jobs/${String(jobId)}`, signal);
    if (
      !record(raw) ||
      raw["id"] !== jobId ||
      raw["run_id"] !== runId ||
      raw["head_sha"] !== check.headSha ||
      raw["name"] !== check.name ||
      !positive(raw["run_attempt"]) ||
      !checkReference(raw["check_run_url"], root, checkId) ||
      typeof raw["status"] !== "string" ||
      (raw["conclusion"] !== null && typeof raw["conclusion"] !== "string")
    )
      return undefined;
    return {
      ...check,
      workflowRunId: runId,
      workflowRunAttempt: raw["run_attempt"],
      status: raw["status"],
      conclusion: raw["conclusion"] ?? "",
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError || error instanceof GitHubRequestCancelledError) throw error;
    if (signal?.aborted === true) throw error;
    return undefined;
  }
}

export async function readObservation(
  url: string,
  signal?: AbortSignal,
  read: ReadGitHub = ghRead,
  now = Date.now,
  readMetadata: typeof githubMetadata.read | undefined = read === ghRead
    ? (url, signal) => githubMetadata.read(url, signal)
    : undefined,
  reconciliation: CheckReconciliationContext = { checks: [] },
): Promise<ObservationInput> {
  const [, owner, repo, , number] = new URL(canonicalPR(url)).pathname.split("/");
  if (owner === undefined || repo === undefined || number === undefined) throw new Error("Invalid GitHub PR URL");
  const root = `repos/${owner}/${repo}`;
  const initial = readMetadata ? await readMetadata(canonicalPR(url), signal) : undefined;
  const pr = initial?.pr ?? trackingPR(await read(`${root}/pulls/${number}`, signal));
  // rationale: The PR payload can retain an ancestor base SHA after the target branch advances.
  const refPath = `${root}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`;
  const readTarget = async () => {
    const raw: unknown = await read(refPath, signal);
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("object" in raw) ||
      typeof raw.object !== "object" ||
      raw.object === null ||
      !("sha" in raw.object) ||
      typeof raw.object.sha !== "string" ||
      raw.object.sha === ""
    )
      throw new Error("Invalid GitHub target branch observation");
    return { ref: pr.base.ref, sha: raw.object.sha };
  };
  const target = initial ? initial.target : pr.state === "open" && !pr.merged ? await readTarget() : undefined;
  const observedAt = now();
  const [runs, statuses, reviews, inline, conversation, workflows] = await Promise.all([
    collection(
      `${root}/commits/${pr.head.sha}/check-runs?filter=latest`,
      "check_runs",
      (value: unknown) => checkRunObservation(value, url),
      read,
      signal,
    ),
    collection(
      `${root}/commits/${pr.head.sha}/statuses`,
      undefined,
      (value: unknown) => {
        if (
          !record(value) ||
          !positive(value["id"]) ||
          typeof value["context"] !== "string" ||
          typeof value["state"] !== "string"
        )
          throw new Error("Invalid GitHub commit status");
        const at = Date.parse(typeof value["created_at"] === "string" ? value["created_at"] : "");
        return {
          id: `status:${String(value["id"])}`,
          key: `status:${value["context"]}`,
          name: value["context"],
          headSha: pr.head.sha,
          status: value["state"],
          conclusion: value["state"],
          at: Number.isFinite(at) ? at : 0,
          url: typeof value["target_url"] === "string" ? value["target_url"] : url,
        };
      },
      read,
      signal,
    ),
    collection(`${root}/pulls/${number}/reviews`, undefined, (r: unknown) => reviewObservation(r, url), read, signal),
    collection(
      `${root}/pulls/${number}/comments`,
      undefined,
      (value: unknown) => commentFeedback(value, "inline", url),
      read,
      signal,
    ),
    collection(
      `${root}/issues/${number}/comments`,
      undefined,
      (value: unknown) => commentFeedback(value, "conversation", url),
      read,
      signal,
    ),
    collection(
      `${root}/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}`,
      "workflow_runs",
      workflowObservation,
      read,
      signal,
    ),
  ]);
  const retainedContext = reconciliation.forHead?.(pr.head.sha) ?? reconciliation;
  const observedIds = new Set(runs.state === "unavailable" ? [] : runs.value.map((check) => check.id));
  const missing = [
    ...new Map(
      retainedContext.checks
        .filter((check) => check.headSha === pr.head.sha && !observedIds.has(check.id))
        .map((check) => [check.id, check]),
    ).values(),
  ];
  missing.sort((a, b) => a.id.localeCompare(b.id));
  const next = missing.findIndex((check) => check.id.localeCompare(retainedContext.after ?? "") > 0);
  const offset = next < 0 ? 0 : next;
  const selected = [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, 10);
  const last = selected.at(-1);
  if (last) retainedContext.selected?.(last.id);
  const reconciled = new Map<string, CheckObservation>();
  for (const check of selected) {
    const result = await reconcileCheck(check, root, read, signal);
    if (result) reconciled.set(check.id, result);
  }
  const retained = missing.map((check) => reconciled.get(check.id) ?? check);
  const workflowEvidence = workflows.state === "unavailable" ? [] : workflows.value;
  const unconfirmed = retained.some(
    (check) =>
      !checksFinished({ state: "complete", value: [check] }) &&
      !workflowEvidence.some((candidate) => checkReplaces(check, candidate)),
  );
  const feedbackItems = [
    ...(reviews.state === "unavailable"
      ? []
      : reviews.value
          .filter((r) => !pendingReview(r.state) && r.body !== undefined && r.body.trim() !== "")
          .map((r) =>
            feedbackRevision({
              source: "review",
              id: r.id,
              author: r.author,
              body: r.body ?? "",
              url: r.url,
              headSha: r.headSha,
            }),
          )),
    ...(inline.state === "unavailable"
      ? []
      : inline.value.filter(
          (c) =>
            reviews.state !== "unavailable" &&
            reviews.value.some((r) => r.id === c.reviewId && !pendingReview(r.state)),
        )),
    ...(conversation.state === "unavailable" ? [] : conversation.value),
  ].filter((f) => f.body.trim() !== "");
  const completeFeedback = [reviews.state, inline.state, conversation.state].every((state) => state === "complete");
  const feedback: NonNullable<ObservationInput["feedback"]> = completeFeedback
    ? { state: "complete", value: feedbackItems }
    : {
        state: "partial",
        value: feedbackItems,
        reason: "Some review or comment sources are incomplete",
      };
  const checks: ObservationInput["checks"] =
    runs.state === "complete" && statuses.state === "complete" && !unconfirmed
      ? {
          state: "complete",
          value: [...runs.value, ...statuses.value, ...retained],
        }
      : runs.state === "unavailable" && statuses.state === "unavailable"
        ? { state: "unavailable", reason: "Checks unavailable" }
        : {
            state: "partial",
            value: [
              ...(runs.state === "unavailable" ? [] : runs.value),
              ...(statuses.state === "unavailable" ? [] : statuses.value),
              ...retained,
            ],
            reason: unconfirmed
              ? "Waiting for terminal evidence for retained executions"
              : "Some check sources are incomplete",
          };
  const latest = !readMetadata ? undefined : await readMetadata(canonicalPR(url), signal);
  const [latestPR, latestTarget] = !latest
    ? await Promise.all([read(`${root}/pulls/${number}`, signal).then(trackingPR), !target ? undefined : readTarget()])
    : [latest.pr, latest.target];
  if (
    latestPR.head.sha !== pr.head.sha ||
    latestPR.base.ref !== pr.base.ref ||
    latestTarget?.sha !== target?.sha ||
    latestPR.state !== pr.state ||
    latestPR.merged !== pr.merged ||
    latestPR.mergeable !== pr.mergeable
  )
    throw new GitHubObservationChangedError();
  return {
    observedAt,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    ...(!target ? {} : { targetBase: target }),
    ...(initial?.description === undefined ? {} : { description: initial.description }),
    lifecycle: pr.merged ? PRLifecycle.Merged : prLifecycle(pr.state),
    mergeability: pr.mergeable === true ? "mergeable" : pr.mergeable === false ? "conflicting" : "unknown",
    checks,
    reviews,
    feedback,
    workflows,
  };
}
