import {
  PRLifecycle,
  ReviewState,
  terminalPR,
  effectiveReview,
  prLifecycle,
  reviewState,
} from "./states.js";
import { actionableFeedback } from "./review-signals.js";
import { checkEvidence, checksFinished, successfulCheck } from "./checks.js";
import {
  ActionState,
  type Action,
  type ActionProgress,
  type Blocker,
  type PRObservation,
} from "./types.js";
export interface Finding {
  sourceKey: string;
  blocker: Blocker;
  summary: string;
  evidenceUrl: string;
}
const failed = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
  "error",
]);
function latest<T>(
  items: T[],
  key: (item: T) => string,
  at: (item: T) => number,
): T[] {
  const map = new Map<string, T>();
  for (const item of items)
    if (!map.has(key(item)) || at(item) >= at(map.get(key(item))!))
      map.set(key(item), item);
  return [...map.values()];
}
export function currentChecks(o: PRObservation) {
  return o.checks.state === "unavailable"
    ? []
    : latest(
        o.checks.value.filter((c) => c.headSha === o.headSha),
        (c) => c.key,
        (c) => c.at,
      );
}
export function currentReviews(o: PRObservation) {
  return o.reviews.state === "unavailable"
    ? []
    : latest(
        o.reviews.value.filter((r) => effectiveReview(r.state)),
        (r) => r.author,
        (r) => r.at,
      );
}
export function findings(o: PRObservation, url: string): Finding[] {
  if (terminalPR(o.lifecycle)) return feedbackFindings(o);
  const found: Finding[] = [];
  const baseSha = o.targetBase?.sha ?? o.baseSha;
  if (o.mergeability === "conflicting")
    found.push({
      sourceKey: `${o.headSha}:${baseSha}`,
      blocker: {
        kind: "conflict",
        headSha: o.headSha,
        baseSha,
        ...(o.targetBase !== undefined ? { baseRef: o.targetBase.ref } : {}),
      },
      summary: "Merge conflict",
      evidenceUrl: url,
    });
  for (const c of o.checks.state === "complete" ? currentChecks(o) : [])
    if (failed.has(c.conclusion))
      found.push({
        sourceKey: c.id,
        blocker: {
          kind: "check_failed",
          sourceId: c.id,
          checkName: c.name,
          headSha: o.headSha,
          checkKey: c.key,
        },
        summary: `Failed check: ${c.name}`,
        evidenceUrl: c.url || url,
      });
  for (const r of o.reviews.state === "complete" ? currentReviews(o) : [])
    if (reviewState(r.state) === ReviewState.ChangesRequested)
      found.push({
        sourceKey: r.id,
        blocker: {
          kind: "changes_requested",
          reviewId: r.id,
          reviewer: r.author,
          reviewedHeadSha: r.headSha,
        },
        summary: `Changes requested by ${r.author}`,
        evidenceUrl: r.url || url,
      });
  return [...found, ...feedbackFindings(o)];
}
function feedbackFindings(o: PRObservation): Finding[] {
  const found: Finding[] = [];
  for (const feedback of o.feedback?.state === "complete"
    ? o.feedback.value
    : []) {
    if (!actionableFeedback(feedback)) continue;
    found.push({
      sourceKey: `${feedback.source}:${feedback.id}:${feedback.revision}`,
      blocker: { kind: "review_feedback", feedback },
      summary: `${feedback.source === "inline" ? "Code review" : feedback.source === "review" ? "Review" : "PR comment"} from ${feedback.author}`,
      evidenceUrl: feedback.url,
    });
  }
  return found;
}
export function closeProgress(
  a: Action,
  o: PRObservation,
  now: number,
  openedOnTerminalPR = false,
): ActionProgress | undefined {
  const supersede = (reason: string): ActionProgress => ({
    state: ActionState.Superseded,
    at: now,
    reason,
  });
  const resolve = (reason: string): ActionProgress => ({
    state: ActionState.Resolved,
    at: now,
    observationId: o.id,
    reason,
  });
  const b = a.blocker;
  if (b.kind === "review_feedback") {
    if (terminalPR(o.lifecycle) && !openedOnTerminalPR)
      return supersede(`PR ${o.lifecycle}`);
    if (!actionableFeedback(b.feedback))
      return supersede("Review lifecycle update has no findings");
    if (o.feedback?.state === "complete") {
      const newer = o.feedback.value.find(
        (f) => f.source === b.feedback.source && f.id === b.feedback.id,
      );
      if (newer !== undefined && newer.revision !== b.feedback.revision)
        return supersede(
          "Comment edited; newer feedback replaces this revision",
        );
    }
    return undefined;
  }
  if (prLifecycle(o.lifecycle) === PRLifecycle.Merged)
    return supersede("PR merged");
  if (a.blocker.kind === "check_results") {
    if (a.blocker.headSha !== o.headSha) return supersede("PR head changed");
    if (a.blocker.checks.every(successfulCheck)) {
      if (terminalPR(o.lifecycle)) return supersede(`PR ${o.lifecycle}`);
      const evidence = checkEvidence(o);
      if (
        evidence.state !== "unavailable" &&
        evidence.value.some(
          (check) =>
            !successfulCheck(check) ||
            !checksFinished({ state: "complete", value: [check] }),
        )
      )
        return supersede("New check evidence changed completion state");
    }
    return undefined;
  }
  if (terminalPR(o.lifecycle)) return supersede(`PR ${o.lifecycle}`);
  if (b.kind !== "changes_requested" && b.headSha !== o.headSha)
    return supersede("PR head changed");
  if (b.kind === "conflict") {
    if (b.baseSha !== (o.targetBase?.sha ?? o.baseSha))
      return supersede("Base head changed");
    if (o.targetBase !== undefined && b.baseRef !== o.targetBase.ref)
      return supersede("Target base evidence refreshed");
    if (o.mergeability === "mergeable")
      return resolve("GitHub confirms no merge conflict");
  }
  if (b.kind === "check_failed" && o.checks.state === "complete") {
    const c = currentChecks(o).find((c) => c.key === b.checkKey);
    if (c && c.id !== b.sourceId)
      return supersede("A newer check execution replaced this failure");
    if (c && ["success", "neutral", "skipped"].includes(c.conclusion))
      return resolve("GitHub confirms check succeeded");
  }
  if (b.kind === "changes_requested" && o.reviews.state === "complete") {
    const r = currentReviews(o).find((r) => r.author === b.reviewer);
    if (
      r !== undefined &&
      (reviewState(r.state) === ReviewState.Approved ||
        reviewState(r.state) === ReviewState.Dismissed)
    )
      return resolve("GitHub confirms review approved or dismissed");
    if (r !== undefined && r.id !== b.reviewId)
      return supersede("A newer review replaced this request");
  }
}
