import { Type } from "typebox";
import { Check } from "typebox/value";
import { compact } from "../tracking/messages.js";
import { shortId } from "../tracking/identifiers.js";
import type { AcknowledgeAgentDigestResponse } from "../gen/octomanager/v1/notifications_pb.js";
const ReceiptSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    revision: Type.Integer(),
    currentRevision: Type.Integer(),
    agentId: Type.String({ minLength: 1, maxLength: 200 }),
    receivedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);
export function receiptOutput(
  response: AcknowledgeAgentDigestResponse,
  state?: string,
) {
  const receipt: unknown = JSON.parse(response.recordJson);
  if (!Check(ReceiptSchema, receipt))
    throw new Error("Invalid digest receipt response");
  const ids = response.messages
    .flatMap((item) => [
      item.messageId,
      item.actionId,
      item.submissionId ?? "",
      item.ownerAgentId,
    ])
    .filter((id) => id !== "");
  const candidates = response.messages.map((item) => ({
    message: shortId(item.messageId, ids),
    ...(item.actionId === "" ? {} : { action: shortId(item.actionId, ids) }),
    ...(item.submissionId === undefined
      ? {}
      : { submission: shortId(item.submissionId, ids) }),
    applicable: item.applicable,
    summary: compact(item.summary, 160),
    ...(item.prUrl === "" ? {} : { pr: item.prUrl }),
    ...(item.recipientRole === "" ? {} : { role: item.recipientRole }),
    ...(item.ownerAgentId === ""
      ? {}
      : { owner: shortId(item.ownerAgentId, ids) }),
  }));
  const stateSuffix =
    state === undefined ? "" : ` --state '${state.replaceAll("'", "'\"'\"'")}'`;
  const stateFits = Buffer.byteLength(JSON.stringify(stateSuffix)) <= 1000;
  const result = {
    receipt: {
      digest: shortId(receipt.id),
      revision: receipt.revision,
      currentRevision: receipt.currentRevision,
      agent: shortId(receipt.agentId),
      receivedAtMs: receipt.receivedAtMs,
    },
    items: candidates.slice(0, 20),
    omittedItems: Math.max(0, candidates.length - 20),
    inspect: `octo-manager digest ${shortId(receipt.id)} --revision ${String(receipt.revision)}${stateFits ? stateSuffix : ""}`,
    ...(stateFits ? {} : { inspectState: "Reuse the same --state argument" }),
  };
  while (
    Buffer.byteLength(JSON.stringify(result)) > 6000 &&
    result.items.length > 0
  ) {
    result.items.pop();
    result.omittedItems++;
  }
  return result;
}
