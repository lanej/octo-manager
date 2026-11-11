import { canonicalPR } from "../tracking/github.js";
export enum RepairState {
  Queued = "queued",
  Running = "running",
  AwaitingChecks = "awaiting_checks",
  Succeeded = "succeeded",
  Blocked = "blocked",
  Failed = "failed",
  Uncertain = "uncertain",
}
export enum RepairStep {
  Fetch = "fetch",
  Rebase = "rebase",
  Resolve = "resolve",
  Checks = "checks",
  Push = "push",
  Verify = "verify",
}
export interface RepairProfile {
  repository: string;
  harness: "pi";
  model: string;
  instructions: string;
  checks: string[][];
  githubChecks: string[];
  timeoutMs: number;
}
export interface RebaseInput {
  requestId: string;
  prUrl: string;
  profile: string;
}
export interface RebaseSource {
  repository: string;
  headRef: string;
  headSha: string;
  targetRef: string;
  targetSha: string;
}
export interface RepairAttempt {
  id: string;
  request: RebaseInput;
  profile: RepairProfile;
  prId: string;
  state: RepairState;
  step: RepairStep;
  detail: string;
  createdAt: number;
  updatedAt: number;
  source?: RebaseSource;
  resultHead?: string;
  conflictedPaths: string[];
  workspace?: string;
  usedAgent: boolean;
  history: {
    state: RepairState;
    step: RepairStep;
    detail: string;
    at: number;
  }[];
}
export interface RepairWorkerTask {
  kind: "repair_conflicts";
  instructions: string;
  paths: string[];
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid repair object");
  return Object.fromEntries(Object.entries(value));
}
export function single(value: unknown, name: string, limit = 200): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > limit ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`Invalid repair ${name}`);
  return value;
}
export function rebaseInput(value: unknown): RebaseInput {
  const r = record(value);
  return {
    requestId: single(r["requestId"], "request ID"),
    prUrl: canonicalPR(single(r["prUrl"], "PR URL", 2000)),
    profile: single(r["profile"], "profile"),
  };
}
export function repairProfile(value: unknown): RepairProfile {
  const r = record(value);
  const repository = single(r["repository"], "repository").toLowerCase();
  if (
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(repository) ||
    repository.split("/").some((x) => x === "." || x === "..") ||
    r["harness"] !== "pi"
  )
    throw new Error("Invalid repair repository or unsupported harness");
  const checks = r["checks"];
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 10)
    throw new Error(
      "Invalid repair checks; configure at least one validation command",
    );
  const argv = checks.map((command: unknown) => {
    if (!Array.isArray(command) || command.length === 0 || command.length > 30)
      throw new Error("Invalid repair command");
    return command.map((arg: unknown) => single(arg, "command argument", 2000));
  });
  const required = r["githubChecks"];
  if (!Array.isArray(required) || required.length === 0 || required.length > 30)
    throw new Error(
      "Invalid repair GitHub checks; configure expected check names",
    );
  const githubChecks = required.map((name: unknown) =>
    single(name, "GitHub check name"),
  );
  const timeout = r["timeoutMs"] ?? 120000;
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 600000
  )
    throw new Error("Invalid repair timeout");
  return {
    repository,
    harness: "pi",
    model: single(r["model"], "model"),
    instructions: single(r["instructions"], "instructions", 8000),
    checks: argv,
    githubChecks,
    timeoutMs: timeout,
  };
}
export function activeRepair(state: RepairState): boolean {
  return (
    state === RepairState.Queued ||
    state === RepairState.Running ||
    state === RepairState.AwaitingChecks
  );
}

export function storedRepair(value: unknown): RepairAttempt {
  const r = record(value);
  const state = Object.values(RepairState).find((s) => s === r["state"]);
  const step = Object.values(RepairStep).find((s) => s === r["step"]);
  if (state === undefined || step === undefined)
    throw new Error("Invalid stored repair state");
  const paths = r["conflictedPaths"];
  if (!Array.isArray(paths)) throw new Error("Invalid stored repair paths");
  const createdAt = r["createdAt"],
    updatedAt = r["updatedAt"];
  if (
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(updatedAt)
  )
    throw new Error("Invalid repair timestamps");
  const a: RepairAttempt = {
    id: single(r["id"], "ID"),
    request: rebaseInput(r["request"]),
    profile: repairProfile(r["profile"]),
    prId: single(r["prId"], "PR ID"),
    state,
    step,
    detail: single(r["detail"], "detail", 2000),
    createdAt,
    updatedAt,
    usedAgent: r["usedAgent"] === true,
    history: [],
    conflictedPaths: paths.map((path: unknown) =>
      single(path, "file path", 4000),
    ),
  };
  const history = r["history"];
  if (!Array.isArray(history)) throw new Error("Invalid repair history");
  for (const item of history) {
    const h = record(item);
    const state = Object.values(RepairState).find((s) => s === h["state"]);
    const step = Object.values(RepairStep).find((s) => s === h["step"]);
    const at = h["at"];
    if (
      state === undefined ||
      step === undefined ||
      typeof at !== "number" ||
      !Number.isSafeInteger(at)
    )
      throw new Error("Invalid repair history");
    a.history.push({
      state,
      step,
      at,
      detail: single(h["detail"], "history detail", 2000),
    });
  }
  if (r["workspace"] !== undefined)
    a.workspace = single(r["workspace"], "workspace", 4000);
  if (r["resultHead"] !== undefined)
    a.resultHead = single(r["resultHead"], "result revision");
  if (r["source"] !== undefined) {
    const source = record(r["source"]);
    a.source = {
      repository: single(source["repository"], "repository"),
      headRef: single(source["headRef"], "source branch"),
      headSha: single(source["headSha"], "source revision"),
      targetRef: single(source["targetRef"], "target branch"),
      targetSha: single(source["targetSha"], "target revision"),
    };
  }
  return a;
}
export function repairWorkerTask(value: unknown): RepairWorkerTask {
  const raw = record(value);
  const paths = raw["paths"];
  if (raw["kind"] !== "repair_conflicts" || !Array.isArray(paths))
    throw new Error("Invalid repair worker task");
  return {
    kind: "repair_conflicts",
    instructions: single(raw["instructions"], "instructions", 8000),
    paths: paths.map((path: unknown) => single(path, "path", 4000)),
  };
}
