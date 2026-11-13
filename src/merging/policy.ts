import { createHash } from "node:crypto";
import { canonicalPR } from "../tracking/github.js";
import { actionableFeedback } from "../tracking/review-signals.js";
import { compact } from "../tracking/messages.js";
import type { PRObservation, TrackedPR } from "../tracking/types.js";
import type { Dependency, PRReference } from "./contracts.js";
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function feedbackKey(observation: PRObservation): string | undefined {
  if (
    observation.feedback?.state !== "complete" ||
    observation.reviews.state !== "complete"
  )
    return undefined;
  return fingerprint([
    observation.feedback.value
      .filter(actionableFeedback)
      .map((item) => [item.source, item.id, item.revision])
      .sort(),
    observation.reviews.value
      .filter((item) => item.state === "CHANGES_REQUESTED")
      .map((item) => [item.id, item.author, item.headSha])
      .sort(),
  ]);
}
export function graphKey(dependencies: Dependency[], prId: string): string {
  return fingerprint(
    dependencies
      .filter((edge) => edge.active && edge.dependentId === prId)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
export function acyclic(
  edges: Pick<Dependency, "dependentId" | "prerequisiteId">[],
): void {
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error("Dependency cycle rejected");
    if (done.has(id)) return;
    active.add(id);
    for (const edge of edges)
      if (edge.dependentId === id) visit(edge.prerequisiteId);
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
export function references(
  pr: TrackedPR,
  sources: ReferenceSource[],
  known: TrackedPR[],
): Omit<PRReference, "decision" | "createdAt" | "active">[] {
  const result = new Map<
    string,
    Omit<PRReference, "decision" | "createdAt" | "active">
  >();
  const repository = new URL(pr.url).pathname.split("/").slice(1, 3).join("/");
  for (const source of sources) {
    const matches = [
      ...source.text.matchAll(
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
      if (target === pr.url) continue;
      const at = match.index,
        begin = source.text.lastIndexOf("\n", at) + 1,
        end = source.text.indexOf("\n", at);
      const line = source.text.slice(begin, end < 0 ? undefined : end),
        excerpt = compact(line, 480);
      const hint =
        /\b(?:depends on|blocked by|requires merging|after merging)\s/iu.test(
          line,
        )
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
  entry: import("./contracts.js").MergeEntry,
  snapshot: import("./github.js").MergeSnapshot,
): string | undefined {
  const observation = snapshot.observation;
  if (snapshot.draft) return "PR is a draft";
  if (snapshot.queueRequired)
    return "Repository requires GitHub merge queue; direct merging is disabled";
  if (!snapshot.methods.includes(entry.method))
    return `Repository does not allow ${entry.method} merging`;
  if (observation.mergeability !== "mergeable")
    return "Mergeability is not confirmed";
  if (!["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(snapshot.gate))
    return `GitHub merge gate: ${snapshot.gate}`;
  if (snapshot.review !== null && snapshot.review !== "APPROVED")
    return `GitHub review gate: ${snapshot.review}`;
  if (
    observation.checks.state !== "complete" ||
    observation.workflows?.state !== "complete"
  )
    return "Complete check evidence is required";
  const expected = [...new Set([...snapshot.required, ...entry.checks])];
  if (expected.length === 0 && !entry.noCi)
    return "Owner must declare expected checks or explicit no CI";
  for (const name of expected) {
    const matches = [
      ...observation.checks.value,
      ...observation.workflows.value,
    ].filter(
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
