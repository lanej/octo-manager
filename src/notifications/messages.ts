import { inspectMessage } from "./inspection.js";
import type { Store } from "../store.js";
import type { DigestService } from "./service.js";

export class Messages {
  constructor(
    private store: Store,
    private digests: DigestService,
  ) {}
  private resolve(id: string) {
    const grouped = this.store.digests.findDelivery(id);
    const single = this.store.tracking.inbox.get(id);
    if (grouped !== undefined && single !== undefined)
      throw new Error("Invalid ambiguous message ID; use a longer ID");
    if (grouped !== undefined)
      return {
        kind: "grouped" as const,
        revision: grouped,
        recipient: this.store.digests.get(grouped.digestId).agentId,
      };
    if (single !== undefined)
      return {
        kind: "single" as const,
        revision: {
          dispatchId: single.id,
          body: single.body,
          messageIds: [single.id],
          createdAt: single.createdAt,
        },
        recipient: single.recipientAgentId,
      };
    throw new Error("Message not found");
  }
  get(id: string, full = false) {
    const value = this.resolve(id);
    return inspectMessage(this.store, value.revision, value.recipient, full);
  }
  acknowledge(id: string, agentId: string, expectedBody?: string) {
    const value = this.resolve(id);
    if (value.recipient !== agentId)
      throw new Error("Message belongs to another agent");
    if (expectedBody !== undefined && expectedBody !== value.revision.body)
      throw new Error(
        "Invalid message text; does not match the stored delivery",
      );
    if (value.kind === "grouped")
      this.digests.acknowledge(
        value.revision.digestId,
        value.revision.revision,
        agentId,
        expectedBody,
      );
    else
      this.store.tracking.acknowledgeMessage(
        value.revision.dispatchId,
        agentId,
      );
    return this.get(value.revision.dispatchId);
  }
}
