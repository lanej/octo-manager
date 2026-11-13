import { test, expect } from "bun:test";
import { parseCommand } from "../src/arguments.js";
import { agentResponse } from "../src/cli-output.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
const Schema = Type.Object(
  {
    ok: Type.Literal(true),
    command: Type.String(),
    data: Type.Unknown(),
    omittedItems: Type.Integer(),
    detailsOmitted: Type.Boolean(),
    next: Type.String(),
    reuseArguments: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
function decode(text: string) {
  const value: unknown = JSON.parse(text);
  if (!Check(Schema, value)) throw new Error("Invalid agent response");
  return value;
}
test("explicit JSON is separate from agent detection and full inspection never replays a mutation", () => {
  expect(parseCommand(["tracked"], {}).output).toEqual({
    agent: false,
    json: false,
    full: false,
  });
  expect(parseCommand(["tracked", "--json"], {}).output).toEqual({
    agent: false,
    json: true,
    full: false,
  });
  expect(
    parseCommand(["tracked"], { CODEX_THREAD_ID: "thread" }).output,
  ).toEqual({ agent: true, json: true, full: false });
  expect(
    parseCommand(["tracked"], { CODEX_THREAD_ID: "  " }).output.agent,
  ).toBe(false);
  expect(
    parseCommand(["tracked"], {
      CODEX_THREAD_ID: "thread",
      OCTO_MANAGER_AGENT: "0",
    }).output.agent,
  ).toBe(false);
  expect(
    parseCommand(["tracked", "--agent"], { OCTO_MANAGER_AGENT: "0" }).output
      .agent,
  ).toBe(true);
  expect(
    parseCommand(["tracked"], { OCTO_MANAGER_AGENT: "1" }).values.json,
  ).toBe(true);
  expect(
    parseCommand(["pr", "p", "--full"], { CODEX_THREAD_ID: "thread" }).output
      .full,
  ).toBe(true);
  for (const command of [
    "track",
    "acknowledge-digest",
    "rebase",
    "retry-submission",
  ])
    expect(() => parseCommand([command, "--full"], {})).toThrow("read-only");
  expect(() => parseCommand(["repo-policy", "refresh", "--full"], {})).toThrow(
    "read-only",
  );
  expect(() =>
    parseCommand(["events", "job", "--watch"], { OCTO_MANAGER_AGENT: "1" }),
  ).toThrow("bounded responses");
});
test("agent output bounds actionable rows, excludes evidence payloads and retains complete links", () => {
  const parsed = parseCommand(["tracking", "--state", "/tmp/custom state"], {
    OCTO_MANAGER_AGENT: "1",
  });
  const evidenceUrl =
    "https://github.com/" + "r".repeat(160) + "/actions/runs/1";
  const output = agentResponse(parsed, {
    prs: Array.from({ length: 20 }, () => ({
      id: "pr",
      observation: { checksJson: "PRIVATE CHECK HISTORY" },
    })),
    actions: Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      state: "open",
      summary: "A failing check",
      evidenceUrl,
      blocker: {
        case: "check_failed",
        value: { checkName: "CI", headSha: "a".repeat(40) },
      },
    })),
    events: [{ body: "PRIVATE EVENT HISTORY" }],
  });
  const response = decode(output);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(3000);
  expect(response.omittedItems).toBeGreaterThanOrEqual(32);
  expect(response.detailsOmitted).toBe(true);
  expect(output).not.toContain("PRIVATE");
  expect(output).toContain(evidenceUrl);
  const data = response.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("actions" in data) ||
    !Array.isArray(data.actions)
  )
    throw new Error("Missing actionable rows");
  const actions: unknown[] = data.actions;
  expect(actions[0]).toMatchObject({
    state: "open",
    summary: "A failing check",
  });
  expect(response.next).toContain("'tracking'");
  expect(response.next).toContain("'--full'");
  expect(response.next).toContain("'/tmp/custom state'");
});
test("mutation results point to read-only inspection and JSON escaping cannot exceed the budget", () => {
  const parsed = parseCommand(
    [
      "track",
      "--url",
      "https://github.com/o/r/pull/1",
      "--state",
      "/" + "a'".repeat(1600),
    ],
    { CODEX_THREAD_ID: "thread" },
  );
  const output = agentResponse(parsed, {
    pr: {
      id: "tracked-id",
      url: "https://github.com/o/r/pull/1",
      enabled: true,
      observation: { reviewsJson: "REVIEWBODY" },
    },
  });
  const result = decode(output);
  expect(result.next).not.toContain("'track'");
  expect(result.reuseArguments).toBe(true);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(3000);
  const retry = decode(
    agentResponse(
      parseCommand(["retry-delivery", "delivery"], { OCTO_MANAGER_AGENT: "1" }),
      { delivery: { id: "delivery", actionId: "action" } },
    ),
  );
  expect(retry.next).toContain("'action' 'action'");
  expect(retry.next).not.toContain("retry-delivery");
  const activity = decode(
    agentResponse(
      parseCommand(["record-activity"], { OCTO_MANAGER_AGENT: "1" }),
      {
        activity: {
          sequence: "2345",
          report: { outcome: "succeeded", detail: "Actual result" },
        },
      },
    ),
  );
  expect(activity.next).toContain("'--after' '2344'");
});
