import { printResult } from "../cli-output.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { toJson } from "@bufbuild/protobuf";
import { schedulerClient } from "../client.js";
import {
  ConflictDecision,
  ListConflictCasesResponseSchema,
  GetConflictCaseResponseSchema,
  RepairState,
  RequestRebaseResponseSchema,
  ListRepairsResponseSchema,
} from "../gen/octomanager/v1/repairs_pb.js";
import type { parseCommand } from "../arguments.js";
export async function repairsCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (
    command !== "rebase" &&
    command !== "repairs" &&
    command !== "conflict-cases" &&
    command !== "conflict-case"
  )
    return false;
  if (values.help === true) {
    console.log(
      "rebase --url PR_URL --profile NAME --request-id ID [--state DIR]\nrepairs [--state DIR] [--json]\nconflict-cases [--after ID] [--json]\nconflict-case ID [--json]\nAn explicit rebase request authorizes the configured repository's source branch update after validation. Conflicts use a separate bounded repair session.",
    );
    return true;
  }
  if (positionals.length !== (command === "conflict-case" ? 2 : 1))
    throw new Error("Unexpected repair arguments");
  const client = schedulerClient(
    resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local", "state", "octo-manager"),
    ),
  );
  const label = (url: string) =>
    url.replace("https://github.com/", "").replace("/pull/", "#");
  if (command === "conflict-cases") {
    const after = values.after ?? "0";
    if (!/^\d+$/u.test(after)) throw new Error("Invalid case cursor");
    const response = await client.listConflictCases({ afterId: BigInt(after) });
    if (values.json)
      printResult(parsed, toJson(ListConflictCasesResponseSchema, response));
    else {
      for (const c of response.cases)
        console.log(
          `Case ${String(c.id)} · ${label(c.prUrl)} · ${c.path} · ${ConflictDecision[c.decision].replace("CONFLICT_DECISION_", "").toLowerCase()} · ${c.reason}`,
        );
      if (response.cases.length === 0)
        console.log("No conflict cases recorded.");
    }
    return true;
  }
  if (command === "conflict-case") {
    const id = positionals[1] ?? "";
    if (!/^\d+$/u.test(id)) throw new Error("Invalid case ID");
    const response = await client.getConflictCase({ id: BigInt(id) });
    if (values.json)
      printResult(parsed, toJson(GetConflictCaseResponseSchema, response));
    else {
      const c = response.conflictCase;
      if (c !== undefined)
        console.log(
          `Case ${String(c.id)} · ${label(c.prUrl)} · ${c.path}\n${c.reason}\nUse --json to recover the retained input versions and candidate.`,
        );
    }
    return true;
  }
  if (command === "rebase") {
    const response = await client.requestRebase({
      url: values.url ?? "",
      profile: values.profile ?? "",
      requestId: values["request-id"] ?? "",
    });
    if (values.json)
      printResult(parsed, toJson(RequestRebaseResponseSchema, response));
    else
      console.log(
        `Rebase requested for ${label(values.url ?? "PR")}. Follow progress in Tracking or with octo-manager repairs.`,
      );
  } else {
    const response = await client.listRepairs({});
    if (values.json)
      printResult(parsed, toJson(ListRepairsResponseSchema, response));
    else {
      for (const repair of response.repairs)
        console.log(
          `${label(repair.prUrl)} · ${RepairState[repair.state].replace("REPAIR_STATE_", "").toLowerCase().replaceAll("_", " ")} · ${repair.detail}`,
        );
      if (response.repairs.length === 0) console.log("No rebase repairs yet.");
    }
  }
  return true;
}
