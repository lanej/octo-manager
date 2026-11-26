import { mergeRequest } from "../api/merge-client.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { schedulerClient } from "../client.js";
import { printResult } from "../cli/output.js";
import type { parseCommand } from "../cli/arguments.js";
import { checked, CommandSchema, QueueInputSchema, type MergeCommand } from "./contracts.js";

export async function mergingCLI(parsed: ReturnType<typeof parseCommand>): Promise<boolean> {
  const [rawCommand, id] = parsed.positionals,
    { values } = parsed;
  const command = rawCommand ?? "";
  let input: MergeCommand;
  const actorId = values["agent-id"] ?? "";
  const intent = (): unknown => {
    const path = values["intent-file"];
    if (path === undefined) throw new Error("--intent-file is required");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value;
  };
  switch (command) {
    case "merge-policy":
      input = {
        op: "policy",
        pr: id ?? "",
        actorId,
        checks: (values.checks ?? "").split(",").filter((value) => value !== ""),
        noCi: values.ci === false,
      };
      if (input.noCi && input.checks.length > 0) throw new Error("Choose expected checks or --no-ci");
      break;
    case "auto-merge":
      if ([values.on, values.off, values.inherit].filter((value) => value === true).length !== 1)
        throw new Error("Choose --on, --off, or --inherit");
      input = {
        op: "auto_merge",
        ...(values.inherit === true ? { inherit: true } : {}),
        ...(values.instructions === undefined ? {} : { instructions: values.instructions }),
        pr: id ?? "",
        enabled: values.on === true,
        actorId,
        requestId: values["request-id"] ?? randomUUID(),
      };
      break;
    case "chains":
      input = { op: "inspect", ...(id === undefined ? {} : { id }) };
      break;
    case "references":
    case "dependencies":
      input = { op: command, ...(id === undefined ? {} : { pr: id }) };
      break;
    case "queue-chain":
      input = { op: "queue", input: checked(QueueInputSchema, intent()) };
      break;
    case "dependency-confirm":
      input = {
        op: "confirm",
        pr: values.pr ?? "",
        prerequisite: values.prerequisite ?? "",
        actorId,
        reason: values.reason ?? "",
      };
      break;
    case "reference-dismiss":
      input = { op: "decide", id: id ?? "", actorId, decision: "dismissed" };
      break;
    case "merge-ready":
      input = { op: "ready", pr: id ?? "", head: values.head ?? "", actorId };
      break;
    case "dependency-remove":
      input = { op: "remove", id: id ?? "", actorId };
      break;
    case "pause-chain":
      input = { op: "pause", id: id ?? "" };
      break;
    case "resume-chain":
      input = { op: "resume", id: id ?? "" };
      break;
    case "cancel-chain":
      input = { op: "cancel", id: id ?? "" };
      break;
    case "reconcile-operation":
      input = { op: "reconcile", id: id ?? "" };
      break;
    default:
      return false;
  }
  checked(CommandSchema, input);
  const directory = resolve(
    values.state ?? process.env["OCTO_MANAGER_STATE"] ?? join(homedir(), ".local/state/octo-manager"),
  );
  const value = await mergeRequest(schedulerClient(directory), input);
  printResult(parsed, value);
  return true;
}
