import { toJson } from "@bufbuild/protobuf";
import { record } from "../api/codec.js";
import {
  ReadNotificationMessageResponseSchema,
  NotificationMessageSchema,
  NotificationItemSchema,
  type ReadNotificationMessageResponse,
} from "../gen/octomanager/v2/notifications_pb.js";

const bookkeeping = new Set([
  "recipientAgentId",
  "ownerAgentId",
  "openedObservationId",
  "sourceKey",
  "createdAtMs",
  "updatedAtMs",
  "progressAtMs",
  "history",
  "untrustedEvidence",
  "profile",
]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(strip);
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !bookkeeping.has(key))
      .map(([key, item]) => [key, strip(item)]),
  );
}

export function readOutput(response: ReadNotificationMessageResponse, agent: boolean): unknown {
  const json = record(toJson(ReadNotificationMessageResponseSchema, response));
  if (response.message !== undefined)
    json["message"] = {
      ...record(toJson(NotificationMessageSchema, response.message)),
      items: response.message.items.map((item) => ({
        ...record(toJson(NotificationItemSchema, item)),
        applicable: item.applicable,
      })),
    };
  return agent ? strip(json) : json;
}
