import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AcknowledgeAgentDigestResponseSchema } from "../src/gen/octomanager/v1/notifications_pb.js";
import { receiptOutput } from "../src/notifications/receipt-output.js";
test("receipt output bounds dense revision metadata and exposes omitted item retrieval without history", () => {
  const response = create(AcknowledgeAgentDigestResponseSchema, {
    recordJson: JSON.stringify({
      id: "a".repeat(32),
      revision: 2,
      currentRevision: 4,
      agentId: "b".repeat(32),
      receivedAtMs: 1000,
    }),
    messages: Array.from({ length: 20 }, (_, index) => ({
      messageId: `${index.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`,
      actionId: `${index.toString(16).padStart(8, "0")}-2222-2222-2222-222222222222`,
      summary: "Useful finding ".repeat(100),
      prUrl: "https://github.com/" + "x".repeat(300),
      ownerAgentId: "b".repeat(32),
      recipientRole: "observer",
      applicable: index % 2 === 0,
    })),
  });
  const result = receiptOutput(response, "/tmp/state with 'quotes'");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6000);
  const quoted = receiptOutput(response, "/" + "a'".repeat(1000));
  expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThanOrEqual(6000);
  expect(quoted.inspectState).toBe("Reuse the same --state argument");
  expect(quoted.inspect).not.toContain("--state");
  const controls = receiptOutput(
    response,
    "/" + Array.from({ length: 4 }, () => "\u0001".repeat(200)).join("/"),
  );
  expect(Buffer.byteLength(JSON.stringify(controls))).toBeLessThanOrEqual(6000);
  expect(controls.inspectState).toBe("Reuse the same --state argument");
  expect(result.items.length + result.omittedItems).toBe(20);
  expect(result.omittedItems).toBeGreaterThan(0);
  expect(result.receipt.currentRevision).toBe(4);
  expect(result.items.some((item) => !item.applicable)).toBe(true);
  expect(result.inspect).toContain("--revision 2 --state");
  expect(() =>
    receiptOutput({ ...response, recordJson: '{"events":[]}' }),
  ).toThrow("Invalid digest receipt");
});
