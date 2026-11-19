import type { DatabaseSync } from "node:sqlite";
import { storedCheckEvidence } from "./checks.js";
import { storedFeedback, storedReviews } from "./feedback.js";
import { targetBase } from "./evidence.js";
import { prLifecycle, type PRLifecycle } from "./states.js";
import type { ObservationInput, PRObservation } from "./types.js";

export interface ObservationRepository {
  append(prId: string, input: ObservationInput): PRObservation;
  latest(prId: string): PRObservation | undefined;
  lifecycle(id: number): PRLifecycle;
}

// Uses the caller's transaction so observation, actions and deliveries commit together.
export class SQLiteObservationRepository implements ObservationRepository {
  constructor(private readonly db: DatabaseSync) {}
  append(prId: string, input: ObservationInput): PRObservation {
    const lifecycle = prLifecycle(input.lifecycle);
    const reviews = storedReviews(input.reviews);
    const result = this.db
      .prepare(
        "INSERT INTO pr_observations(pr_id,observed_at_ms,head_sha,base_sha,lifecycle,mergeability,checks_state,checks_json,reviews_state,reviews_json,target_base_json,feedback_json,workflow_runs_json,description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        prId,
        input.observedAt,
        input.headSha,
        input.baseSha,
        lifecycle,
        input.mergeability,
        input.checks.state,
        JSON.stringify(input.checks),
        reviews.state,
        JSON.stringify(reviews),
        input.targetBase === undefined
          ? null
          : JSON.stringify(input.targetBase),
        input.feedback === undefined ? null : JSON.stringify(input.feedback),
        input.workflows === undefined ? null : JSON.stringify(input.workflows),
        input.description ?? null,
      );
    return {
      ...input,
      lifecycle,
      reviews,
      id: Number(result.lastInsertRowid),
      prId,
    };
  }
  latest(prId: string): PRObservation | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM pr_observations WHERE pr_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(prId);
    return row === undefined ? undefined : this.decode(row);
  }
  lifecycle(id: number): PRLifecycle {
    const row = this.db
      .prepare("SELECT lifecycle FROM pr_observations WHERE id=?")
      .get(id);
    if (row === undefined) throw new Error("Opening PR observation not found");
    return prLifecycle(row["lifecycle"]);
  }
  private decode(row: Record<string, unknown>): PRObservation {
    const target = targetBase(row["target_base_json"]);
    const feedback = storedFeedback(row["feedback_json"]);
    const workflows = storedCheckEvidence(row["workflow_runs_json"]);
    const checks = storedCheckEvidence(row["checks_json"]);
    if (checks === undefined) throw new Error("Missing stored check evidence");
    return {
      id: integer(row["id"]),
      prId: text(row["pr_id"]),
      observedAt: integer(row["observed_at_ms"]),
      headSha: text(row["head_sha"]),
      baseSha: text(row["base_sha"]),
      lifecycle: prLifecycle(row["lifecycle"]),
      mergeability: mergeability(row["mergeability"]),
      checks,
      reviews: storedReviews(row["reviews_json"]),
      ...(target === undefined ? {} : { targetBase: target }),
      ...(feedback === undefined ? {} : { feedback }),
      ...(workflows === undefined ? {} : { workflows }),
      ...(typeof row["description"] === "string"
        ? { description: row["description"] }
        : {}),
    };
  }
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid stored observation text");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Invalid stored observation number");
  return value;
}
function mergeability(value: unknown): PRObservation["mergeability"] {
  switch (value) {
    case "mergeable":
      return "mergeable";
    case "conflicting":
      return "conflicting";
    case "unknown":
      return "unknown";
    default:
      throw new Error("Invalid stored mergeability");
  }
}
