import { test, expect } from "bun:test";
import { workerResultText } from "../src/worker-result.js";

test("structured worker results preserve complete JSON beyond the prose limit", () => {
  const payload = { body: "A".repeat(20000) + "\n終", blockers: [] };
  const json = JSON.stringify(payload);
  const wire = workerResultText("structured", json);
  const decoded: unknown = JSON.parse(wire);
  expect(decoded).toEqual(payload);
  expect(wire).toBe(json);
  expect(() => workerResultText("structured", "終".repeat(22000))).toThrow(
    "exceeds limit",
  );
});
