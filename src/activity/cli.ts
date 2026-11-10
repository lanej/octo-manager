import { toJson } from "@bufbuild/protobuf";
import { RecordActivityResponseSchema } from "../gen/octomanager/v1/activity_pb.js";
import { ListActivityResponseSchema } from "../gen/octomanager/v1/scheduler_pb.js";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { schedulerClient } from "../client.js";
import { activityInput } from "./types.js";
import { wireActivityInput } from "./rpc.js";

export async function activityCLI(args: string[]): Promise<boolean> {
  if (args[0] !== "record-activity" && args[0] !== "activity") return false;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      name: { type: "string" },
      outcome: { type: "string" },
      "request-id": { type: "string" },
      "operation-id": { type: "string" },
      harness: { type: "string" },
      "thread-id": { type: "string" },
      "harness-version": { type: "string" },
      model: { type: "string" },
      url: { type: "string" },
      detail: { type: "string" },
      evidence: { type: "string" },
      after: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(
      "record-activity --name merge_pr|run_checks|resolve_conflict|summarize_pr|notify_agent --outcome attempted|succeeded|failed|uncertain --request-id ID --operation-id ID --harness NAME --thread-id ID --detail TEXT [--url PR_URL] [--evidence HTTPS_URL] [--harness-version VERSION] [--model MODEL] [--state DIR]\nactivity [--after SEQUENCE] [--state DIR] [--json]\nActivity records caller reports; it does not execute or independently verify the action.",
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
      },
      detail: values.detail,
      prUrl: values.url,
      evidenceUrl: values.evidence,
    });
    console.log(
      JSON.stringify(
        toJson(
          RecordActivityResponseSchema,
          await client.recordActivity({ report: wireActivityInput(input) }),
        ),
        null,
        values.json === true ? undefined : 2,
      ),
    );
  } else {
    const after = values.after ?? "0";
    if (!/^\d+$/u.test(after)) throw new Error("Invalid activity cursor");
    console.log(
      JSON.stringify(
        toJson(
          ListActivityResponseSchema,
          await client.listActivity({ afterSequence: BigInt(after) }),
        ),
        null,
        values.json === true ? undefined : 2,
      ),
    );
  }
  return true;
}
