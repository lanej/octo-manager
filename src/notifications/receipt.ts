import type { DigestService } from "./service.js";
import type { TrackingStore } from "../tracking/store.js";
import type { AgentMessage } from "../tracking/inbox.js";
import { compact } from "../tracking/messages.js";
export function digestReceipt(
  service: DigestService,
  tracking: TrackingStore,
  id: string,
  number: number,
  messages: AgentMessage[],
) {
  const value = service.store.get(id),
    receipt = service.store.receipt(value.id, number);
  if (receipt === undefined) throw new Error("Digest receipt not found");
  return {
    recordJson: JSON.stringify({
      id: value.id,
      revision: number,
      currentRevision: value.revision,
      agentId: value.agentId,
      receivedAtMs: receipt.at,
    }),
    messages: messages.map((message) => {
      const action =
        message.actionId === "" ? undefined : tracking.action(message.actionId);
      const pr =
        action === undefined
          ? message.participantPRId === undefined
            ? undefined
            : tracking.pr(message.participantPRId)
          : tracking.pr(action.prId);
      return {
        messageId: message.id,
        actionId: message.actionId,
        submissionId: message.submissionId,
        applicable: message.applicable,
        acknowledgedAtMs:
          message.acknowledgedAt === undefined
            ? undefined
            : BigInt(message.acknowledgedAt),
        summary: compact(
          action?.summary ??
            (message.participantPRId === undefined
              ? (message.body.split("\n")[0] ?? "Octo update")
              : "PR participants changed"),
          160,
        ),
        prUrl: pr?.url ?? "",
        recipientRole:
          pr === undefined
            ? ""
            : pr.ownerAgentId === message.recipientAgentId
              ? "owner"
              : "observer",
        ownerAgentId: pr?.ownerAgentId ?? "",
      };
    }),
  };
}
