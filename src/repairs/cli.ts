import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { toJson } from "@bufbuild/protobuf";
import { schedulerClient } from "../client.js";
import {
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
  if (command !== "rebase" && command !== "repairs") return false;
  if (values.help === true) {
    console.log(
      "rebase --url PR_URL --profile NAME --request-id ID [--state DIR]\nrepairs [--state DIR] [--json]\nAn explicit rebase request authorizes the configured repository's source branch update after validation. Conflicts use a separate bounded repair session.",
    );
    return true;
  }
  if (positionals.length !== 1) throw new Error("Unexpected repair arguments");
  const client = schedulerClient(
    resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local", "state", "octo-manager"),
    ),
  );
  const label = (url: string) =>
    url.replace("https://github.com/", "").replace("/pull/", "#");
  if (command === "rebase") {
    const response = await client.requestRebase({
      url: values.url ?? "",
      profile: values.profile ?? "",
      requestId: values["request-id"] ?? "",
    });
    if (values.json === true)
      console.log(
        JSON.stringify(toJson(RequestRebaseResponseSchema, response)),
      );
    else
      console.log(
        `Rebase requested for ${label(values.url ?? "PR")}. Follow progress in Tracking or with octo-manager repairs.`,
      );
  } else {
    const response = await client.listRepairs({});
    if (values.json === true)
      console.log(JSON.stringify(toJson(ListRepairsResponseSchema, response)));
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
