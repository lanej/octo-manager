import { unwire } from "../api/codec.js";
import {
  DomainMergeReceiptResultSchema,
  DomainDigestInspectionSchema,
  DomainAgentDigestSchema,
} from "../gen/octomanager/v2/domain_pb.js";
import { revision as digestRevision } from "./types.js";
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
    command !== "merge" &&
    command !== "ack" &&
    command !== "message" &&
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
  if (command === "ack" || command === "merge") {
    if (id === undefined || id === "")
      throw new Error(`${command} requires a message receipt ID`);
    const environmentAgent = process.env["OCTO_MANAGER_AGENT_ID"]?.trim();
    const agentId =
      values["agent-id"] ??
      (environmentAgent === "" ? undefined : environmentAgent);
    const sessionId = values["thread-id"] ?? process.env["CODEX_THREAD_ID"];
    if (
      agentId === undefined &&
      (sessionId === undefined || sessionId.trim() === "")
    )
      throw new Error(
        "Cannot identify this session; set CODEX_THREAD_ID or pass --agent-id",
      );
    const request = {
      receiptId: id,
      ...(agentId === undefined
        ? {
            agentTarget: {
              harness: values.harness ?? "codex",
              endpoint:
                values.endpoint ?? process.env["OCTO_MANAGER_ENDPOINT"] ?? "",
              sessionId: sessionId ?? "",
            },
          }
        : { agentId }),
    };
    if (command === "merge") {
      const response = await client.mergeAgentMessage(request);
      if (response.result === undefined)
        throw new Error("Missing merge result");
      const result = unwire(DomainMergeReceiptResultSchema, response.result);
      printResult(parsed, result);
      return true;
    }
    const response = await client.acknowledgeAgentDigest(request);
    const compact = receiptOutput(response, directory);
    printResult(parsed, {
      receipt: { id },
      items: compact.items,
      omittedItems: compact.omittedItems,
    });
    return true;
  }
  if (command === "message") {
    const response = await client.getAgentDigest({ receiptId: id ?? "" });
    if (response.inspection === undefined)
      throw new Error("Missing message inspection");
    const value = unwire(DomainDigestInspectionSchema, response.inspection);
    if (typeof value !== "object" || value === null || !("revision" in value))
      throw new Error("Invalid message inspection response");
    const stored = digestRevision(value.revision);
    let merge: { pr: string; head: string; method: string } | undefined;
    if (values.full === true && stored.mergeTarget !== undefined) {
      const tracked = await client.getTrackedPullRequest({
        id: stored.mergeTarget.prId,
      });
      if (tracked.pr === undefined)
        throw new Error("Merge target PR not found");
      merge = {
        pr: tracked.pr.url,
        head: stored.mergeTarget.head,
        method: stored.mergeTarget.method,
      };
    }
    printResult(parsed, {
      id: shortId(stored.dispatchId),
      body: stored.body,
      ...(merge === undefined ? {} : { merge }),
    });
    return true;
  }
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
    ).digests.map((value) => unwire(DomainAgentDigestSchema, value));
  else if (command === "digest") {
    const response = await client.getAgentDigest({ id: id ?? "", revision });
    if (response.inspection === undefined)
      throw new Error("Missing digest inspection");
    result = unwire(DomainDigestInspectionSchema, response.inspection);
  } else {
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
