import { printResult } from "../cli-output.js";
import { toJson } from "@bufbuild/protobuf";
import { RecordActivityResponseSchema } from "../gen/octomanager/v1/activity_pb.js";
import { ListActivityResponseSchema } from "../gen/octomanager/v1/scheduler_pb.js";
import type { parseCommand } from "../arguments.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { schedulerClient } from "../client.js";
import { activityInput } from "./types.js";
import { wireActivityInput } from "./rpc.js";

export async function activityCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed;
  if (positionals[0] !== "record-activity" && positionals[0] !== "activity")
    return false;
  if (values.help === true) {
    console.log(
      "record-activity --name merge_pr|run_checks|resolve_conflict|summarize_pr|notify_agent --outcome attempted|succeeded|failed|uncertain --request-id ID --operation-id ID --harness NAME --thread-id ID --detail TEXT [--url PR_URL] [--evidence HTTPS_URL] [--harness-version VERSION] [--model MODEL] [--label TOPIC] [--cwd DIR] [--state DIR]\nactivity [--after SEQUENCE] [--state DIR] [--json]\nActivity records caller reports; it does not execute or independently verify the action.",
    );
    return true;
  }
  if (positionals.length !== 1)
    throw new Error("Unexpected activity arguments");
  const directory = resolve(
    values.state ??
      process.env["OCTO_MANAGER_STATE"] ??
      join(homedir(), ".local", "state", "octo-manager"),
  );
  const client = schedulerClient(directory);
  if (positionals[0] === "record-activity") {
    const input = activityInput({
      requestId: values["request-id"],
      operationId: values["operation-id"],
      name: values.name,
      outcome: values.outcome,
      actor: {
        harness: values.harness,
        sessionId: values["thread-id"],
        version: values["harness-version"],
        model: values.model,
        label: values.label,
        cwd: values.cwd ?? process.cwd(),
      },
      detail: values.detail,
      prUrl: values.url,
      evidenceUrl: values.evidence,
    });
    printResult(
      parsed,
      toJson(
        RecordActivityResponseSchema,
        await client.recordActivity({ report: wireActivityInput(input) }),
      ),
    );
  } else {
    const after = values.after ?? "0";
    if (!/^\d+$/u.test(after)) throw new Error("Invalid activity cursor");
    printResult(
      parsed,
      toJson(
        ListActivityResponseSchema,
        await client.listActivity({ afterSequence: BigInt(after) }),
      ),
    );
  }
  return true;
}
