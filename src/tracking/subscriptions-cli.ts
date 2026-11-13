import { printResult } from "../cli-output.js";
import { shortId } from "./identifiers.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { parseCommand } from "../arguments.js";
import { schedulerClient } from "../client.js";
export async function subscriptionsCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed,
    [command, id] = positionals;
  if (
    command !== "subscribe" &&
    command !== "unsubscribe" &&
    command !== "participants"
  )
    return false;
  const client = schedulerClient(
    resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local/state/octo-manager"),
    ),
  );
  const offset = Number(values.after ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4294967295)
    throw new Error("Invalid participant offset");
  const result =
    command === "subscribe"
      ? await client.subscribePullRequest({
          id: id ?? values.url ?? "",
          agent: {
            harness: values.harness ?? "codex",
            endpoint: values.endpoint ?? "local",
            sessionId: values["thread-id"] ?? "",
            label: values.label,
          },
        })
      : command === "unsubscribe"
        ? await client.unsubscribePullRequest({
            id: id ?? values.url ?? "",
            agentId: values["agent-id"] ?? "",
          })
        : await client.listPRParticipants({
            id: id ?? values.url ?? "",
            offset,
          });
  const ids = result.participants.map((item) => item.agentId);
  printResult(parsed, {
    ...result,
    participants: result.participants.map((item) => ({
      ...item,
      agentId: shortId(item.agentId, ids),
    })),
  });
  return true;
}
