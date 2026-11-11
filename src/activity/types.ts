import { canonicalPR } from "../tracking/github.js";

export enum ActivityName {
  MergePR = "merge_pr",
  RunChecks = "run_checks",
  ResolveConflict = "resolve_conflict",
  SummarizePR = "summarize_pr",
  NotifyAgent = "notify_agent",
}
export enum ActivityOutcome {
  Attempted = "attempted",
  Succeeded = "succeeded",
  Failed = "failed",
  Uncertain = "uncertain",
}
export interface ActivityActor {
  harness: string;
  sessionId: string;
  version?: string;
  model?: string;
  label?: string;
  cwd?: string;
}
export interface ActivityInput {
  requestId: string;
  operationId: string;
  name: ActivityName;
  outcome: ActivityOutcome;
  actor: ActivityActor;
  detail: string;
  prUrl?: string;
  evidenceUrl?: string;
}
export interface ActivityReport extends ActivityInput {
  sequence: number;
  recordedAt: number;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid activity object");
  }
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, field: string, limit = 200): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > limit ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(`Invalid activity ${field}`);
  }
  return value;
}
function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}
export function activityInput(value: unknown): ActivityInput {
  const input = object(value);
  const name = Object.values(ActivityName).find(
    (item) => item === input["name"],
  );
  const outcome = Object.values(ActivityOutcome).find(
    (item) => item === input["outcome"],
  );
  if (name === undefined || outcome === undefined)
    throw new Error("Invalid activity name or outcome");
  const rawActor = object(input["actor"]);
  const version = optionalText(rawActor["version"], "version");
  const model = optionalText(rawActor["model"], "model");
  const label = optionalText(rawActor["label"], "label");
  const cwd =
    rawActor["cwd"] === undefined
      ? undefined
      : text(rawActor["cwd"], "working directory", 4000);
  const prUrl =
    input["prUrl"] === undefined
      ? undefined
      : canonicalPR(text(input["prUrl"], "PR URL", 2000));
  let evidenceUrl: string | undefined;
  if (input["evidenceUrl"] !== undefined) {
    evidenceUrl = text(input["evidenceUrl"], "evidence URL", 2000);
    const url = new URL(evidenceUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
      throw new Error("Invalid activity evidence URL");
  }
  return {
    requestId: text(input["requestId"], "request ID"),
    operationId: text(input["operationId"], "operation ID"),
    name,
    outcome,
    actor: {
      harness: text(rawActor["harness"], "harness"),
      sessionId: text(rawActor["sessionId"], "session ID"),
      ...(version === undefined ? {} : { version }),
      ...(model === undefined ? {} : { model }),
      ...(label === undefined ? {} : { label }),
      ...(cwd === undefined ? {} : { cwd }),
    },
    detail: text(input["detail"], "detail", 4000),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(evidenceUrl === undefined ? {} : { evidenceUrl }),
  };
}
