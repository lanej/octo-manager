import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CheckObservation,
  ObservationPart,
  PRObservation,
  Blocker,
} from "./types.js";

export enum CheckWatchState {
  Waiting = "waiting",
  Completed = "completed",
  Superseded = "superseded",
  Cancelled = "cancelled",
  Expired = "expired",
}
export interface CheckWatch {
  id: string;
  prId: string;
  headSha: string;
  generation: number;
  state: CheckWatchState;
  evidence: ObservationPart<CheckObservation[]>;
  createdAt: number;
  updatedAt: number;
  replacementHeadSha?: string;
}
const terminal = new Set([
  "success",
  "failure",
  "neutral",
  "skipped",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "error",
]);
export const successfulCheck = (check: CheckObservation): boolean =>
  ["success", "neutral", "skipped"].includes(check.conclusion);
export function checkEvidence(
  observation: PRObservation,
): ObservationPart<CheckObservation[]> {
  const parts = [observation.checks, observation.workflows];
  const entries = parts
    .flatMap((part) =>
      part === undefined || part.state === "unavailable" ? [] : part.value,
    )
    .filter((check) => check.headSha === observation.headSha);
  const current = new Map<string, CheckObservation>();
  for (const check of entries) {
    const key = check.id.startsWith("status:") ? check.key : check.id;
    const previous = current.get(key);
    if (previous === undefined || check.at > previous.at)
      current.set(key, check);
  }
  const value = [...current.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return parts.every((part) => part?.state === "complete")
    ? { state: "complete", value }
    : {
        state: "partial",
        value,
        reason: `Checks: ${observation.checks.state}; workflows: ${observation.workflows?.state ?? "unknown"}. Waiting for complete coverage.`,
      };
}
function executionFinished(check: CheckObservation): boolean {
  return (
    terminal.has(check.conclusion) &&
    (check.id.startsWith("status:")
      ? ["success", "failure", "error"].includes(check.status)
      : check.status === "completed")
  );
}
export function checksFinished(
  evidence: ObservationPart<CheckObservation[]>,
): boolean {
  return (
    evidence.state === "complete" &&
    evidence.value.length > 0 &&
    evidence.value.every(executionFinished)
  );
}
function explicitlyReplaces(
  previous: CheckObservation,
  candidate: CheckObservation,
): boolean {
  if (candidate.key !== previous.key) return false;
  if (previous.id.startsWith("status:") && candidate.id.startsWith("status:")) {
    if (candidate.at > previous.at) return true;
    const oldId = /^status:(\d+)$/.exec(previous.id)?.[1],
      newId = /^status:(\d+)$/.exec(candidate.id)?.[1];
    return (
      candidate.at === previous.at &&
      oldId !== undefined &&
      newId !== undefined &&
      BigInt(newId) > BigInt(oldId)
    );
  }
  const oldAttempt = /^workflow:\d+:(\d+)$/.exec(previous.id)?.[1],
    newAttempt = /^workflow:\d+:(\d+)$/.exec(candidate.id)?.[1];
  return (
    oldAttempt !== undefined &&
    newAttempt !== undefined &&
    BigInt(newAttempt) > BigInt(oldAttempt)
  );
}
function retainEvidence(
  previous: ObservationPart<CheckObservation[]>,
  current: ObservationPart<CheckObservation[]>,
): ObservationPart<CheckObservation[]> {
  if (previous.state === "unavailable") return current;
  const observed = current.state === "unavailable" ? [] : current.value;
  const missing = previous.value.filter(
    (check) =>
      !observed.some(
        (candidate) =>
          candidate.id === check.id || explicitlyReplaces(check, candidate),
      ),
  );
  if (missing.length === 0) return current;
  const value = [...observed, ...missing].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (missing.every(executionFinished) && current.state === "complete")
    return { state: "complete", value };
  return {
    state: "partial",
    value,
    reason:
      "Waiting for complete terminal evidence for previously observed executions",
  };
}
export function checkResultPreview(
  result: Extract<Blocker, { kind: "check_results" }>,
) {
  const checks: CheckObservation[] = [];
  let size = 0;
  for (const check of result.checks) {
    const length = JSON.stringify(check).length;
    if (size + length > 24576) continue;
    checks.push(check);
    size += length;
  }
  return {
    ...result,
    checks,
    totalChecks: result.checks.length,
    omittedChecks: result.checks.length - checks.length,
    fullEvidence:
      "Use the supplied inspect argv for the complete immutable result snapshot",
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid check evidence text");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid check evidence integer");
  return value;
}
export function workflowObservation(value: unknown): CheckObservation {
  if (!object(value)) throw new Error("Invalid workflow run");
  const id = integer(value["id"]),
    attempt = integer(value["run_attempt"] ?? 1);
  const at = Date.parse(
    string(value["run_started_at"] ?? value["created_at"] ?? ""),
  );
  return {
    id: `workflow:${String(id)}:${String(attempt)}`,
    key: `workflow:${String(id)}`,
    name: string(value["name"]),
    headSha: string(value["head_sha"]),
    status: string(value["status"]),
    conclusion: string(value["conclusion"] ?? ""),
    at: Number.isNaN(at) ? 0 : at,
    url: string(value["html_url"]),
  };
}
export function storedCheckEvidence(
  value: unknown,
): ObservationPart<CheckObservation[]> | undefined {
  if (value === null || value === undefined) return undefined;
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!object(raw)) throw new Error("Invalid stored check evidence");
  if (raw["state"] === "unavailable")
    return { state: "unavailable", reason: string(raw["reason"]) };
  if (
    (raw["state"] !== "complete" && raw["state"] !== "partial") ||
    !Array.isArray(raw["value"])
  )
    throw new Error("Invalid stored check coverage");
  const entries: unknown[] = raw["value"];
  const checks = entries.map((entry): CheckObservation => {
    if (!object(entry)) throw new Error("Invalid stored check");
    return {
      id: string(entry["id"]),
      key: string(entry["key"]),
      name: string(entry["name"]),
      headSha: string(entry["headSha"]),
      status: string(entry["status"]),
      conclusion: string(entry["conclusion"]),
      at: integer(entry["at"]),
      url: string(entry["url"]),
    };
  });
  return raw["state"] === "complete"
    ? { state: "complete", value: checks }
    : { state: "partial", value: checks, reason: string(raw["reason"]) };
}
export class CheckWatches {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {}
  hasWaiting(prId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM check_watches WHERE pr_id=? AND state='waiting' LIMIT 1",
        )
        .get(prId) !== undefined
    );
  }
  list(prId?: string): CheckWatch[] {
    return this.db
      .prepare(
        "SELECT * FROM check_watches WHERE (? IS NULL OR pr_id=?) ORDER BY rowid",
      )
      .all(prId ?? null, prId ?? null)
      .map((row) => {
        const state = Object.values(CheckWatchState).find(
          (state) => state === row["state"],
        );
        const evidence = storedCheckEvidence(row["evidence_json"]);
        if (state === undefined || evidence === undefined)
          throw new Error("Invalid stored check watch");
        return {
          id: string(row["id"]),
          prId: string(row["pr_id"]),
          headSha: string(row["head_sha"]),
          generation: integer(row["generation"]),
          state,
          evidence,
          createdAt: integer(row["created_at_ms"]),
          updatedAt: integer(row["updated_at_ms"]),
          ...(row["replacement_head_sha"] === null
            ? {}
            : { replacementHeadSha: string(row["replacement_head_sha"]) }),
        };
      });
  }
  private save(watch: CheckWatch): void {
    this.db
      .prepare(
        "INSERT INTO check_watches(id,pr_id,head_sha,generation,state,evidence_json,created_at_ms,updated_at_ms,replacement_head_sha) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,evidence_json=excluded.evidence_json,updated_at_ms=excluded.updated_at_ms,replacement_head_sha=excluded.replacement_head_sha",
      )
      .run(
        watch.id,
        watch.prId,
        watch.headSha,
        watch.generation,
        watch.state,
        JSON.stringify(watch.evidence),
        watch.createdAt,
        watch.updatedAt,
        watch.replacementHeadSha ?? null,
      );
  }
  observe(observation: PRObservation, forceNew = false): CheckWatch[] {
    const watches = this.list(observation.prId),
      results: CheckWatch[] = [];
    for (const watch of watches.filter(
      (watch) =>
        watch.state === CheckWatchState.Waiting &&
        watch.headSha !== observation.headSha,
    )) {
      const result = {
        ...watch,
        state: CheckWatchState.Superseded,
        replacementHeadSha: observation.headSha,
        updatedAt: this.now(),
      };
      this.save(result);
      results.push(result);
    }
    const evidence = checkEvidence(observation);
    const sameHead = watches.filter(
      (watch) => watch.headSha === observation.headSha,
    );
    const previous = sameHead.at(-1);
    let watch =
      previous?.state === CheckWatchState.Waiting ? previous : undefined;
    const previousChecks =
      previous?.evidence.state === "complete" ||
      previous?.evidence.state === "partial"
        ? previous.evidence.value
        : [];
    const changed =
      previous?.state === CheckWatchState.Completed &&
      evidence.state !== "unavailable" &&
      evidence.value.some((check) => {
        const before = previousChecks.find(
          (candidate) => candidate.id === check.id,
        );
        return (
          before === undefined ||
          before.status !== check.status ||
          before.conclusion !== check.conclusion
        );
      });
    if (
      watch === undefined &&
      observation.lifecycle === "open" &&
      (forceNew ||
        previous === undefined ||
        previous.state === CheckWatchState.Cancelled ||
        previous.state === CheckWatchState.Expired ||
        previous.state === CheckWatchState.Superseded ||
        changed)
    ) {
      watch = {
        id: randomUUID(),
        prId: observation.prId,
        headSha: observation.headSha,
        generation: sameHead.length + 1,
        state: CheckWatchState.Waiting,
        evidence:
          previous === undefined
            ? evidence
            : retainEvidence(previous.evidence, evidence),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    }
    if (watch !== undefined) {
      const retained = retainEvidence(watch.evidence, evidence);
      const next = {
        ...watch,
        evidence: retained,
        updatedAt: this.now(),
        state: checksFinished(retained)
          ? CheckWatchState.Completed
          : CheckWatchState.Waiting,
      };
      this.save(next);
      if (next.state === CheckWatchState.Completed) results.push(next);
    }
    return results;
  }
  cancel(
    prId: string,
    state:
      | CheckWatchState.Cancelled
      | CheckWatchState.Expired = CheckWatchState.Cancelled,
  ): void {
    for (const watch of this.list(prId).filter(
      (watch) => watch.state === CheckWatchState.Waiting,
    ))
      this.save({
        ...watch,
        state,
        updatedAt: this.now(),
      });
  }
}
