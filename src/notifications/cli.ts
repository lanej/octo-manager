import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { parseCommand } from "../arguments.js";
import { schedulerClient, cliJSON } from "../client.js";
export async function notificationsCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed,
    [command, id] = positionals;
  if (
    command !== "digest" &&
    command !== "digests" &&
    command !== "acknowledge-digest"
  )
    return false;
  const directory = resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local/state/octo-manager"),
    ),
    client = schedulerClient(directory);
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
    result = {
      record: JSON.parse(response.recordJson) as unknown,
      messages: response.messages,
    };
  }
  console.log(
    JSON.stringify(result, cliJSON, values.json === true ? undefined : 2),
  );
  return true;
}
