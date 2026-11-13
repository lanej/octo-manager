import { printResult } from "../cli-output.js";
import { shortId } from "../tracking/identifiers.js";
import { receiptOutput } from "./receipt-output.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { parseCommand } from "../arguments.js";
import { schedulerClient } from "../client.js";
export async function notificationsCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed,
    [command, id] = positionals;
  if (
    command !== "digest" &&
    command !== "digests" &&
    command !== "acknowledge-digest" &&
    command !== "acknowledge-message"
  )
    return false;
  const directory = resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local/state/octo-manager"),
    ),
    client = schedulerClient(directory);
  if (command === "acknowledge-message") {
    const response = await client.acknowledgeMessage({
      id: id ?? "",
      agentId: values["agent-id"] ?? "",
    });
    const message = response.message;
    if (message === undefined) throw new Error("Missing message receipt");
    printResult(parsed, {
      message: shortId(message.id),
      applicable: message.applicable,
      receivedAtMs:
        message.acknowledgedAtMs === undefined
          ? undefined
          : Number(message.acknowledgedAtMs),
    });
    return true;
  }
  const revision =
    values.revision === undefined ? undefined : Number(values.revision);
  if (
    revision !== undefined &&
    (!Number.isSafeInteger(revision) || revision < 1 || revision > 4294967295)
  )
    throw new Error("Invalid digest revision");
  let result: unknown;
  if (command === "digests")
    result = (
      await client.listAgentDigests({ agentId: values["agent-id"] })
    ).digestsJson.map((value) => JSON.parse(value) as unknown);
  else if (command === "digest")
    result = JSON.parse(
      (await client.getAgentDigest({ id: id ?? "", revision })).recordJson,
    ) as unknown;
  else {
    if (revision === undefined)
      throw new Error("acknowledge-digest requires --revision N");
    const response = await client.acknowledgeAgentDigest({
      id: id ?? "",
      revision,
      agentId: values["agent-id"] ?? "",
    });
    printResult(parsed, receiptOutput(response, directory));
    return true;
  }
  printResult(parsed, result);
  return true;
}
