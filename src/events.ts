import type { JobEvent } from "./domain.js";
import { actionContext } from "./tracking/evidence.js";

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid stored event text");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Invalid stored event number");
  return value;
}
export function storedEvent(row: Record<string, unknown>): JobEvent {
  const context = actionContext(row["action_context_json"]);
  return {
    seq: integer(row["seq"]),
    jobId: text(row["job_id"]),
    at: integer(row["at"]),
    kind: text(row["kind"]),
    detail: text(row["detail"]),
    ...(row["pr_id"] === null || row["pr_id"] === undefined
      ? {}
      : { prId: text(row["pr_id"]) }),
    ...(row["action_id"] === null || row["action_id"] === undefined
      ? {}
      : { actionId: text(row["action_id"]) }),
    ...(context === undefined ? {} : { actionContext: context }),
  };
}
