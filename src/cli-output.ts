import type { parseCommand } from "./arguments.js";
import { agentMode, readOnlyCommand } from "./cli-mode.js";
import { cliJSON } from "./client.js";
import { compact } from "./tracking/messages.js";
const scalarFields = new Set([
  "chainId",
  "entryId",
  "dependentId",
  "prerequisiteId",
  "targetUrl",
  "hint",
  "active",
  "mergeCommit",
  "preparedHead",
  "nextAt",
  "id",
  "url",
  "prUrl",
  "evidenceUrl",
  "checkName",
  "author",
  "reviewer",
  "path",
  "line",
  "decision",
  "prId",
  "actionId",
  "messageId",
  "submissionId",
  "agentId",
  "ownerAgentId",
  "recipientAgentId",
  "sequence",
  "seq",
  "jobId",
  "at",
  "refreshError",
  "refreshErrorAtMs",
  "observedAtMs",
  "revision",
  "currentRevision",
  "receivedAtMs",
  "acknowledgedAtMs",
  "state",
  "status",
  "trackingState",
  "enabled",
  "lifecycle",
  "mergeability",
  "headSha",
  "baseSha",
  "summary",
  "detail",
  "error",
  "reason",
  "closeReason",
  "name",
  "outcome",
  "kind",
  "case",
  "role",
  "recipientRole",
  "label",
  "harness",
  "cwd",
  "total",
  "hasMore",
  "applicable",
  "digest",
  "message",
  "action",
  "owner",
  "agent",
  "omittedItems",
  "inspectState",
  "step",
  "resultHead",
  "originalHead",
  "targetSha",
  "targetRef",
  "usedAgent",
  "mechanicalRepairs",
]);
const containers = new Set([
  "chains",
  "entries",
  "operations",
  "dependencies",
  "references",
  "pr",
  "prs",
  "action",
  "actions",
  "messages",
  "participants",
  "receipt",
  "digest",
  "revision",
  "delivery",
  "items",
  "activity",
  "report",
  "reports",
  "actor",
  "repairs",
  "repair",
  "cases",
  "conflictCase",
  "agent",
  "agents",
  "target",
  "observation",
  "blocker",
  "value",
  "jobs",
  "conflict",
  "github",
  "deliveries",
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface Omission {
  remaining: number;
  items: number;
  details: boolean;
}
function project(value: unknown, omission: Omission, depth = 0): unknown {
  if (typeof value === "string") {
    const text = compact(value, 160);
    if (text !== value) omission.details = true;
    return text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) {
    const rows: unknown[] = value;
    const count = Math.min(omission.remaining, rows.length);
    omission.remaining -= count;
    omission.items += rows.length - count;
    return rows
      .slice(0, count)
      .map((item) => project(item, omission, depth + 1));
  }
  if (!record(value) || depth > 5) {
    omission.details = true;
    return undefined;
  }
  const result: Record<string, unknown> = {};
  const priority = ["actions", "messages", "items", "participants", "repairs"];
  const rank = (key: string) => {
    const index = priority.indexOf(key);
    return index < 0 ? priority.length : index;
  };
  const entries = Object.entries(value).sort(
    ([left], [right]) => rank(left) - rank(right),
  );
  for (const [key, item] of entries) {
    if (
      scalarFields.has(key) &&
      (typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null)
    ) {
      if (
        ["url", "prUrl", "evidenceUrl"].includes(key) &&
        typeof item === "string"
      ) {
        if (Buffer.byteLength(item) <= 512) result[key] = item;
        else omission.details = true;
      } else result[key] = project(item, omission, depth + 1);
    } else if (containers.has(key) && (record(item) || Array.isArray(item)))
      result[key] = project(item, omission, depth + 1);
    else omission.details = true;
  }
  return result;
}
function shrink(value: unknown, omission: Omission): boolean {
  if (Array.isArray(value)) {
    if (value.length > 1) {
      value.pop();
      omission.items++;
      return true;
    }
    for (const item of value) if (shrink(item, omission)) return true;
    return false;
  }
  if (!record(value)) return false;
  for (const item of Object.values(value))
    if (shrink(item, omission)) return true;
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      Buffer.byteLength(item) > 48 &&
      ![
        "id",
        "actionId",
        "agentId",
        "messageId",
        "ownerAgentId",
        "prId",
        "submissionId",
        "url",
        "prUrl",
        "evidenceUrl",
        "checkName",
        "author",
        "reviewer",
        "path",
        "line",
        "decision",
        "headSha",
        "baseSha",
      ].includes(key)
    ) {
      value[key] = compact(item, 48);
      omission.details = true;
      return true;
    }
  }
  return false;
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function lookup(raw: unknown, key: string): string | undefined {
  if (!record(raw)) return undefined;
  const item = raw[key];
  return typeof item === "string" && item !== "" ? item : undefined;
}
function inspectArgs(
  parsed: ReturnType<typeof parseCommand>,
  raw: unknown,
): string[] {
  const { values, positionals } = parsed,
    command = positionals[0] ?? "";
  if (
    [
      "queue-chain",
      "merge-command",
      "merge-ready",
      "dependency-remove",
      "pause-chain",
      "resume-chain",
      "cancel-chain",
      "reconcile-operation",
    ].includes(command)
  )
    return ["chains"];
  if (readOnlyCommand(positionals)) {
    const args = [...positionals];
    for (const [flag, value] of [
      ["state", values.state],
      ["agent-id", values["agent-id"]],
      ["after", values.after],
      ["revision", values.revision],
      ["version", values.version],
      ["tier", values.tier],
      ["repo", values.repo],
      ["url", values.url],
    ] as const)
      if (value !== undefined) args.push("--" + flag, value);
    if (values["include-acknowledged"] === true)
      args.push("--include-acknowledged");
    if (values["applicable-only"] === true) args.push("--applicable-only");
    return [...args, "--full"];
  }
  const root = record(raw) ? raw : {},
    pr = record(root["pr"]) ? root["pr"] : root,
    action = record(root["action"]) ? root["action"] : root;
  if (["track", "refresh", "assign", "untrack"].includes(command))
    return [
      "pr",
      lookup(pr, "id") ?? positionals[1] ?? values.url ?? "",
      "--full",
    ];
  if (command === "retry-delivery") {
    const delivery = record(root["delivery"]) ? root["delivery"] : {};
    return ["action", lookup(delivery, "actionId") ?? "", "--full"];
  }
  if (["acknowledge", "working", "reprofile"].includes(command))
    return ["action", lookup(action, "id") ?? positionals[1] ?? "", "--full"];
  if (command === "subscribe" || command === "unsubscribe")
    return ["participants", positionals[1] ?? values.url ?? "", "--full"];
  if (command === "acknowledge-digest") {
    const receipt = record(root["receipt"]) ? root["receipt"] : {};
    return [
      "digest",
      lookup(receipt, "digest") ?? positionals[1] ?? "",
      "--revision",
      values.revision ?? "1",
      "--full",
    ];
  }
  if (command === "acknowledge-message")
    return [
      "inbox",
      "--agent-id",
      values["agent-id"] ?? "",
      "--include-acknowledged",
      "--full",
    ];
  if (command === "record-activity") {
    const activity = record(root["activity"]) ? root["activity"] : {};
    const sequence = lookup(activity, "sequence");
    return [
      "activity",
      "--after",
      sequence !== undefined && /^\d+$/u.test(sequence)
        ? String(BigInt(sequence) > 0n ? BigInt(sequence) - 1n : 0n)
        : "0",
      "--full",
    ];
  }
  if (command === "rebase") return ["repairs", "--full"];
  if (
    command === "submit-pr" ||
    command === "retry-submission" ||
    command === "cancel-submission"
  )
    return ["submission", lookup(root, "id") ?? positionals[1] ?? "", "--full"];
  if (command === "submit" || command === "cancel" || command === "retry")
    return ["get", lookup(root, "id") ?? positionals[1] ?? "", "--full"];
  return ["--help"];
}
export function agentResponse(
  parsed: ReturnType<typeof parseCommand>,
  raw: unknown,
): string {
  const normalized: unknown = JSON.parse(
      JSON.stringify(raw === undefined ? null : raw, cliJSON),
    ),
    omission: Omission = { remaining: 8, items: 0, details: false };
  const args = inspectArgs(parsed, normalized);
  if (parsed.values.state !== undefined && !args.includes("--state"))
    args.push("--state", parsed.values.state);

  let next = ["octo-manager", ...args.map(quote)].join(" ");
  const reuseArguments = Buffer.byteLength(JSON.stringify(next)) > 1000;
  if (reuseArguments)
    next =
      "Use the read-only inspection command with the same arguments and --full";
  const result = {
    ok: true,
    command: compact(parsed.positionals[0] ?? "", 40),
    data: project(normalized, omission),
    omittedItems: 0,
    detailsOmitted: false,
    next,
    ...(reuseArguments ? { reuseArguments: true } : {}),
  };
  const sync = () => {
    result.omittedItems = omission.items;
    result.detailsOmitted = omission.details;
  };
  sync();
  while (
    Buffer.byteLength(JSON.stringify(result)) > 3000 &&
    shrink(result.data, omission)
  )
    sync();
  if (Buffer.byteLength(JSON.stringify(result)) > 3000) {
    const original = result.data;
    result.data = record(original)
      ? Object.fromEntries(
          Object.entries(original).filter(([key]) =>
            ["id", "state", "status", "applicable", "receipt"].includes(key),
          ),
        )
      : null;
    result.detailsOmitted = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 3000) {
    result.data = null;
    result.detailsOmitted = true;
  }
  return JSON.stringify(result);
}
export function printResult(
  parsed: ReturnType<typeof parseCommand>,
  result: unknown,
): void {
  console.log(
    parsed.output.agent && !parsed.output.full
      ? agentResponse(parsed, result)
      : JSON.stringify(
          result,
          cliJSON,
          parsed.values.json ||
            ["acknowledge-digest", "acknowledge-message"].includes(
              parsed.positionals[0] ?? "",
            )
            ? undefined
            : 2,
        ),
  );
}
export function printFailure(
  error: unknown,
  args: string[],
  env: NodeJS.ProcessEnv,
): void {
  const message =
    error instanceof Error ? error.message : "CLI operation failed";
  if (
    agentMode(args.includes("--agent"), env) ||
    args.includes("--json") ||
    args.includes("--full")
  )
    console.error(
      JSON.stringify({
        ok: false,
        command: compact(args[0] ?? "", 40),
        error: { message: compact(message, 240) },
      }),
    );
  else console.error(message);
}
