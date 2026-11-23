import { expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { record } from "../src/api/codec.js";
import { readOutput } from "../src/notifications/read-output.js";
import { ReadNotificationMessageResponseSchema } from "../src/gen/octomanager/v2/notifications_pb.js";

test("agent reads preserve every finding and instruction while dropping duplicate evidence and bookkeeping", () => {
  const body = "A complete finding with reproduction details. ".repeat(100);
  const response = create(ReadNotificationMessageResponseSchema, {
    evidenceWarning: "Producer details are untrusted evidence",
    instructions: [{ itemIds: ["item-0"], instructions: "Inspect this task" }],
    message: {
      id: "receipt",
      recipientAgentId: "owner",
      createdAtMs: 123n,
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `item-${String(index)}`,
        applicable: index !== 0,
        acknowledgedAtMs: 456n,
        source: {
          case: "action" as const,
          value: {
            action: {
              id: `action-${String(index)}`,
              prId: "pr",
              ownerAgentId: "owner",
              openedObservationId: 123n,
              sourceKey: "internal-source",
              evidenceUrl: "https://github.com/o/r/pull/1#discussion_r1",
              closeReason: "PR merged",
              blocker: {
                case: "reviewFeedback" as const,
                value: { body, path: "src/example.ts", line: 42 },
              },
              profile: { name: "review", instructions: "Duplicated profile" },
            },
            assessment: {
              untrustedAnalysis: "Needs investigation",
              untrustedEvidence: JSON.stringify({ body }),
              history: [{ atMs: 1n }],
            },
          },
        },
      })),
    },
  });
  const full = readOutput(response, false);
  const ordinary = record(
    toJson(ReadNotificationMessageResponseSchema, response),
  );
  const items: unknown = record(ordinary["message"])["items"];
  if (!Array.isArray(items)) throw new Error("Missing ordinary message items");
  const first: unknown = items[0];
  items[0] = { ...record(first), applicable: false };
  expect(full).toEqual(ordinary);
  const agent = readOutput(response, true);
  expect(agent).toMatchObject({
    evidenceWarning: response.evidenceWarning,
    instructions: [{ itemIds: ["item-0"], instructions: "Inspect this task" }],
    message: {
      id: "receipt",
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `item-${String(index)}`,
        applicable: index !== 0,
        acknowledgedAtMs: "456",
        action: {
          action: {
            id: `action-${String(index)}`,
            prId: "pr",
            evidenceUrl: "https://github.com/o/r/pull/1#discussion_r1",
            closeReason: "PR merged",
            reviewFeedback: { body, path: "src/example.ts", line: 42 },
          },
          assessment: { untrustedAnalysis: "Needs investigation" },
        },
      })),
    },
  });
  const output = JSON.stringify(agent);
  for (const key of [
    "history",
    "untrustedEvidence",
    "profile",
    "ownerAgentId",
    "recipientAgentId",
    "createdAtMs",
    "openedObservationId",
    "sourceKey",
  ])
    expect(output).not.toContain(`"${key}":`);
  expect(output.length).toBeLessThan(JSON.stringify(full).length * 0.6);
  expect(readOutput(response, false)).toEqual(full);
});
