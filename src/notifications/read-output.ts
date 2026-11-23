import { toJson } from "@bufbuild/protobuf";
import { record } from "../api/codec.js";
import {
  ReadNotificationMessageResponseSchema,
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

export function readOutput(
  response: ReadNotificationMessageResponse,
  agent: boolean,
): unknown {
  const json = record(toJson(ReadNotificationMessageResponseSchema, response));
  if (json["message"] !== undefined) {
    const message = record(json["message"]);
    if (Array.isArray(message["items"])) {
      const items: unknown[] = message["items"];
      message["items"] = items.map((value) => ({
        applicable: false,
        ...record(value),
      }));
    }
    json["message"] = message;
  }
  return agent ? strip(json) : json;
}
