import { pendingReview, ReviewState, reviewState } from "../tracking/states.js";
import { ReviewAssessmentSource, type MergeEntry } from "./contracts.js";
import { currentMergeChecks } from "./checks.js";
import { createHash } from "node:crypto";
import { canonicalPR } from "../github/pr-identity.js";
import { actionableFeedback } from "../tracking/review-signals.js";
import { compact } from "../tracking/messages.js";
import type { ObservationInput, TrackedPR } from "../tracking/types.js";
import type { Dependency, PRReference } from "./contracts.js";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function feedbackKey(observation: ObservationInput): string | undefined {
  if (
    observation.feedback?.state !== "complete" ||
    observation.reviews.state !== "complete" ||
    observation.reviews.value.some((review) => pendingReview(review.state))
  )
    return undefined;
  return fingerprint([
    observation.feedback.value
      .filter(actionableFeedback)
      .map((item) => [item.source, item.id, item.revision])
      .sort(),
    observation.reviews.value
      .filter((item) => reviewState(item.state) === ReviewState.ChangesRequested)
      .map((item) => [item.id, item.author, item.headSha])
      .sort(),
  ]);
}

export function pendingReviewReason(observation: ObservationInput): string | undefined {
  if (observation.reviews.state !== "complete") return "Complete review evidence is required";
  if (observation.reviews.value.some((review) => pendingReview(review.state)))
    return "A pending review must be submitted or dismissed";
  return undefined;
}

export function reviewGate(observation: ObservationInput, assessment?: MergeEntry["ready"]): string | undefined {
  const pending = pendingReviewReason(observation);
  if (pending !== undefined) return pending;
  const feedback = feedbackKey(observation);
  if (feedback === undefined) return "Complete review evidence is required";
  if (
    observation.feedback?.state === "complete" &&
    observation.feedback.value.some(actionableFeedback) &&
    (assessment?.source !== ReviewAssessmentSource.Owner ||
      assessment.head !== observation.headSha ||
      assessment.feedback !== feedback)
  )
    return "Review feedback requires owner assessment";
  return undefined;
}

export function graphKey(dependencies: Dependency[], prId: string): string {
  return fingerprint(
    dependencies.filter((edge) => edge.active && edge.dependentId === prId).sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function acyclic(edges: Pick<Dependency, "dependentId" | "prerequisiteId">[]): void {
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error("Dependency cycle rejected");
    if (done.has(id)) return;
    active.add(id);
    for (const edge of edges) if (edge.dependentId === id) visit(edge.prerequisiteId);
    active.delete(id);
    done.add(id);
  }
  for (const edge of edges) visit(edge.dependentId);
}

export interface ReferenceSource {
  key: string;
  text: string;
  url: string;
}

// Preserve character offsets so evidence excerpts still point at the original line.
function referenceProse(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker)
          fence = undefined;
        return " ".repeat(line.length);
      }
      if (marker !== undefined) {
        fence = marker;
        return " ".repeat(line.length);
      }
      return line
        .replace(/(`+)(.*?)\1/gu, (value: string) => " ".repeat(value.length))
        .replace(
          /\[[^\]\n]*\]\((https:\/\/github\.com\/[^)]+)\)/gu,
          (value: string, url: string) => " ".repeat(value.length - url.length - 1) + url + ")",
        );
    })
    .join("\n");
}

export function references(
  pr: Pick<TrackedPR, "id" | "url">,
  sources: ReferenceSource[],
  known: readonly Pick<TrackedPR, "url">[],
): Omit<PRReference, "decision" | "createdAt" | "active">[] {
  const result = new Map<string, Omit<PRReference, "decision" | "createdAt" | "active">>();
  const repository = new URL(pr.url).pathname.split("/").slice(1, 3).join("/");
  for (const source of sources) {
    const prose = referenceProse(source.text);
    const matches = [
      ...prose.matchAll(
        /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\b|(?<![\w/])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*\b/gu,
      ),
    ];
    for (const match of matches) {
      let target: string,
        targetKind: "pr" | "issue_or_pr" = "pr";
      if (match[0].startsWith("https://")) target = canonicalPR(match[0]);
      else {
        const [repo, number] = match[0].split("#");
        target = canonicalPR(
          `https://github.com/${repo === "" || repo === undefined ? repository : repo}/pull/${number ?? ""}`,
        );
        if (!known.some((item) => item.url === target)) {
          target = target.replace("/pull/", "/issues/");
          targetKind = "issue_or_pr";
        }
      }
      if (target === pr.url || target.length > 512) continue;
      const at = match.index,
        begin = source.text.lastIndexOf("\n", at) + 1,
        end = source.text.indexOf("\n", at);
      const line = source.text.slice(begin, end < 0 ? undefined : end),
        excerpt = compact(line, 480);
      const hint = /\b(?:depends on|blocked by|requires merging|after merging)\s/iu.test(line)
        ? "depends_on"
        : "mentioned";
      const revision = fingerprint([source.key, target, excerpt, hint]),
        id = fingerprint([pr.id, source.key, target, revision]);
      result.set(id, {
        id,
        prId: pr.id,
        targetUrl: target,
        targetKind,
        sourceKey: source.key,
        revision,
        evidenceUrl: source.url,
        excerpt,
        hint,
      });
    }
  }
  return [...result.values()];
}

export function readyFor(
  entry: import("./contracts.js").MergeEntry,
  pr: TrackedPR,
  dependencies: Dependency[],
): boolean {
  const ready = entry.ready,
    observation = pr.observation;
  return (
    ready !== undefined &&
    observation !== undefined &&
    ready.epoch === pr.trackingEpoch &&
    ready.head === observation.headSha &&
    ready.baseRef === observation.targetBase?.ref &&
    ready.ownerId === pr.ownerAgentId &&
    ready.feedback === feedbackKey(observation) &&
    ready.graph === graphKey(dependencies, pr.id)
  );
}

export function checkGate(
  entry: Pick<import("./contracts.js").MergeEntry, "method" | "checks" | "noCi" | "ready">,
  snapshot: import("./github.js").MergeSnapshot,
): string | undefined {
  const observation = snapshot.observation;
  const review = reviewGate(observation, entry.ready);
  if (review !== undefined) return review;
  if (snapshot.draft) return "PR is a draft";
  if ((snapshot.nativePrerequisites?.length ?? 0) > 0)
    return `Waiting for native stack predecessor: ${snapshot.nativePrerequisites?.[0] ?? ""}`;
  if (snapshot.queueRequired) return "Repository requires GitHub merge queue; direct merging is disabled";
  if (!snapshot.methods.includes(entry.method)) return `Repository does not allow ${entry.method} merging`;
  if (observation.mergeability !== "mergeable") return "Mergeability is not confirmed";
  if (!["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(snapshot.gate)) return `GitHub merge gate: ${snapshot.gate}`;
  if (snapshot.review !== null && snapshot.review !== "APPROVED") return `GitHub review gate: ${snapshot.review}`;
  if (observation.checks.state !== "complete" || observation.workflows?.state !== "complete")
    return "Complete check evidence is required";
  const expected = [...new Set([...snapshot.required, ...entry.checks])];
  if (expected.length === 0 && !entry.noCi) return "Owner must declare expected checks or explicit no CI";
  for (const name of expected) {
    const matches = currentMergeChecks(observation).filter(
      (check) => check.headSha === observation.headSha && check.name === name,
    );
    if (matches.length === 0) return `Waiting for expected check: ${name}`;
    if (
      matches.some(
        (check) =>
          !["success", "neutral", "skipped"].includes(check.conclusion) ||
          !["completed", "success"].includes(check.status),
      )
    )
      return `Waiting for passing check: ${name}`;
  }
  return undefined;
}
