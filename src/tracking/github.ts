import {
  commentFeedback,
  feedbackRevision,
  reviewObservation,
} from "./feedback.js";
import { workflowObservation } from "./checks.js";
import { trackingPR } from "./evidence.js";
import { githubReads, GitHubRateLimitError } from "../github-api.js";
import { githubMetadata } from "./metadata.js";
import type { ObservationInput, ObservationPart } from "./types.js";
export type ReadGitHub = (path: string, signal?: AbortSignal) => Promise<any>;
export async function ghRead(path: string, signal?: AbortSignal): Promise<any> {
  return githubReads.read(path, signal);
}
export function canonicalPR(url: string): string {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      url,
    );
  if (!m || [".", ".."].includes(m[1]!) || [".", ".."].includes(m[2]!))
    throw new Error("Invalid GitHub PR URL");
  return `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/pull/${m[3]}`;
}
async function collection<T>(
  path: string,
  field: string | undefined,
  map: (x: any) => T,
  read: ReadGitHub,
  signal?: AbortSignal,
): Promise<ObservationPart<T[]>> {
  const items: T[] = [];
  try {
    // WHY: Bounded pagination exposes incomplete evidence instead of clearing blockers from a truncated read.
    for (let page = 1; page <= 10; page++) {
      const raw = await read(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
      );
      const values = field ? raw[field] : raw;
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
    return items.length
      ? {
          state: "partial",
          value: items,
          reason: "A later page could not be read",
        }
      : { state: "unavailable", reason: "GitHub collection unavailable" };
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
): Promise<ObservationInput> {
  const [, owner, repo, , number] = new URL(canonicalPR(url)).pathname.split(
    "/",
  );
  if (owner === undefined || repo === undefined || number === undefined)
    throw new Error("Invalid GitHub PR URL");
  const root = `repos/${owner}/${repo}`;
  const initial =
    readMetadata !== undefined
      ? await readMetadata(canonicalPR(url), signal)
      : undefined;
  const pr =
    initial?.pr ?? trackingPR(await read(`${root}/pulls/${number}`, signal));
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
  const target =
    initial !== undefined
      ? initial.target
      : pr.state === "open" && !pr.merged
        ? await readTarget()
        : undefined;
  const observedAt = now();
  const [runs, statuses, reviews, inline, conversation, workflows] =
    await Promise.all([
      collection(
        `${root}/commits/${pr.head.sha}/check-runs?filter=latest`,
        "check_runs",
        (c: any) => ({
          id: `run:${c.id}`,
          key: `run:${c.app?.id ?? ""}:${c.name}`,
          name: String(c.name),
          headSha: String(c.head_sha),
          status: String(c.status),
          conclusion: String(c.conclusion ?? ""),
          at: Date.parse(c.started_at ?? c.completed_at ?? "") || 0,
          url: String(c.html_url ?? url),
        }),
        read,
        signal,
      ),
      collection(
        `${root}/commits/${pr.head.sha}/statuses`,
        undefined,
        (c: any) => ({
          id: `status:${c.id}`,
          key: `status:${c.context}`,
          name: String(c.context),
          headSha: pr.head.sha,
          status: String(c.state),
          conclusion: String(c.state),
          at: Date.parse(c.created_at ?? "") || 0,
          url: String(c.target_url ?? url),
        }),
        read,
        signal,
      ),
      collection(
        `${root}/pulls/${number}/reviews`,
        undefined,
        (r: unknown) => reviewObservation(r, url),
        read,
        signal,
      ),
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
  const feedbackItems = [
    ...(reviews.state === "unavailable"
      ? []
      : reviews.value
          .filter(
            (r) =>
              r.state !== "PENDING" &&
              r.body !== undefined &&
              r.body.trim() !== "",
          )
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
            reviews.value.some(
              (r) => r.id === c.reviewId && r.state !== "PENDING",
            ),
        )),
    ...(conversation.state === "unavailable" ? [] : conversation.value),
  ].filter((f) => f.body.trim() !== "");
  const completeFeedback = [
    reviews.state,
    inline.state,
    conversation.state,
  ].every((state) => state === "complete");
  const feedback: NonNullable<ObservationInput["feedback"]> = completeFeedback
    ? { state: "complete", value: feedbackItems }
    : {
        state: "partial",
        value: feedbackItems,
        reason: "Some review or comment sources are incomplete",
      };
  const checks: ObservationInput["checks"] =
    runs.state === "complete" && statuses.state === "complete"
      ? { state: "complete", value: [...runs.value, ...statuses.value] }
      : runs.state === "unavailable" && statuses.state === "unavailable"
        ? { state: "unavailable", reason: "Checks unavailable" }
        : {
            state: "partial",
            value: [
              ...(runs.state === "unavailable" ? [] : runs.value),
              ...(statuses.state === "unavailable" ? [] : statuses.value),
            ],
            reason: "Some check sources are incomplete",
          };
  const latest =
    readMetadata === undefined
      ? undefined
      : await readMetadata(canonicalPR(url), signal);
  const [latestPR, latestTarget] =
    latest === undefined
      ? await Promise.all([
          read(`${root}/pulls/${number}`, signal).then(trackingPR),
          target === undefined ? undefined : readTarget(),
        ])
      : [latest.pr, latest.target];
  if (
    latestPR.head.sha !== pr.head.sha ||
    latestPR.base.ref !== pr.base.ref ||
    latestTarget?.sha !== target?.sha ||
    latestPR.state !== pr.state ||
    latestPR.merged !== pr.merged ||
    latestPR.mergeable !== pr.mergeable
  )
    throw new Error(
      "GitHub PR revisions changed during observation; refresh again",
    );
  return {
    observedAt,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    ...(target === undefined ? {} : { targetBase: target }),
    ...(initial?.description === undefined
      ? {}
      : { description: initial.description }),
    lifecycle: pr.merged ? "merged" : pr.state,
    mergeability:
      pr.mergeable === true
        ? "mergeable"
        : pr.mergeable === false
          ? "conflicting"
          : "unknown",
    checks,
    reviews,
    feedback,
    workflows,
  };
}
