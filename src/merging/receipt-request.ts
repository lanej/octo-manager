import type { DigestService } from "../notifications/service.js";
import type { TrackingStore } from "../tracking/store.js";
import type { ReceiptMerges } from "./receipts.js";
import type { MergeStore } from "./store.js";

interface ReceiptMergeRequest {
  receiptId: string;
  agentId: string;
  agentTarget?:
    | { harness: string; sessionId: string; endpoint: string }
    | undefined;
  expectedPr?: string | undefined;
  expectedHead?: string | undefined;
}

export function requestReceiptMerge(
  request: ReceiptMergeRequest,
  tracking: TrackingStore,
  store: MergeStore,
  receipts: ReceiptMerges,
  digests: DigestService,
) {
  const { receiptId, agentId, agentTarget, expectedPr, expectedHead } = request;
  if (agentId !== "" && agentTarget !== undefined)
    throw new Error("Invalid mixed recipient references");
  let recipient = agentId;
  if (agentTarget !== undefined) {
    recipient = tracking.sessionAgent(
      agentTarget.harness,
      agentTarget.sessionId,
      agentTarget.endpoint === "" ? undefined : agentTarget.endpoint,
    );
  } else if (agentId !== "") {
    recipient = store.actor(agentId);
  }

  if (expectedPr !== undefined || expectedHead !== undefined) {
    if (expectedPr === undefined || expectedHead === undefined)
      throw new Error(
        "Invalid Pi merge request: expected PR and head are required together",
      );
    return store.transaction(() =>
      receipts.requestFromInbox(receiptId, recipient, expectedPr, expectedHead),
    );
  }

  const version = digests.store.delivery(receiptId);
  digests.acknowledge(version.digestId, version.revision, recipient);
  const target = version.mergeTarget;
  if (target === undefined)
    return { state: "blocked", reason: "This message has no merge target" };
  return store.transaction(() =>
    receipts.request(target, version.dispatchId, recipient),
  );
}
