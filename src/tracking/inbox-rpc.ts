import { Code, ConnectError } from "@connectrpc/connect";
import type {
  AcknowledgeMessageRequest,
  ListAgentMessagesRequest,
} from "../gen/octomanager/v1/tracking_pb.js";
import type { AgentMessage } from "./inbox.js";
import type { TrackingStore } from "./store.js";
function wire(message: AgentMessage) {
  return {
    ...message,
    sequence: BigInt(message.sequence),
    createdAtMs: BigInt(message.createdAt),
    ...(message.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAtMs: BigInt(message.acknowledgedAt) }),
  };
}
export function inboxRoutes(store: TrackingStore) {
  return {
    listAgentMessages(request: ListAgentMessagesRequest) {
      if (!store.agents().some((agent) => agent.id === request.agentId))
        throw new ConnectError("Agent not found", Code.NotFound);
      const after = Number(request.afterSequence);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ConnectError("Invalid inbox cursor", Code.InvalidArgument);
      const page = store.inbox.list(
        request.agentId,
        after,
        request.includeAcknowledged,
        request.applicableOnly,
      );
      return {
        messages: page.messages.map(wire),
        nextSequence: BigInt(page.nextSequence),
        hasMore: page.hasMore,
      };
    },
    acknowledgeMessage(request: AcknowledgeMessageRequest) {
      const message = store.inbox.get(request.id);
      if (message === undefined)
        throw new ConnectError("Message not found", Code.NotFound);
      if (message.recipientAgentId !== request.agentId)
        throw new ConnectError(
          "Message belongs to another agent",
          Code.PermissionDenied,
        );
      if (
        request.expectedBody !== undefined &&
        request.expectedBody !== message.body
      )
        throw new ConnectError(
          "Message text does not match the stored notification",
          Code.InvalidArgument,
        );
      return {
        message: wire(store.acknowledgeMessage(request.id, request.agentId)),
      };
    },
  };
}
