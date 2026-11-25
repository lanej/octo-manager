import { test, expect, spyOn } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import {
  PendingActionSchema,
  GetActionResponseSchema,
} from "../src/gen/octomanager/v2/tracking_pb.js";
import { NotificationMessageSchema } from "../src/gen/octomanager/v2/notifications_pb.js";
import { parseCommand } from "../src/cli/arguments.js";
import { agentResponse, printFailure } from "../src/cli/output.js";
import { commandSpecs } from "../src/cli/command-tree.js";
import {
  agentProjection,
  agentOutputExceptions,
} from "../src/cli/agent-output.js";
function output(args: string[], raw: unknown): unknown {
  return JSON.parse(
    agentResponse(parseCommand(args, { OCTO_MANAGER_AGENT: "1" }), raw),
  );
}
test("explicit JSON is separate from agent detection and full inspection never replays a mutation", () => {
  expect(parseCommand(["pr", "list"], {}).output).toEqual({
    agent: false,
    json: false,
    full: false,
  });
  expect(parseCommand(["pr", "list", "--json"], {}).output).toEqual({
    agent: false,
    json: true,
    full: false,
  });
  expect(
    parseCommand(["pr", "list"], { CODEX_THREAD_ID: "thread" }).output,
  ).toEqual({ agent: true, json: true, full: false });
  expect(
    parseCommand(["pr", "list"], { CODEX_THREAD_ID: "  " }).output.agent,
  ).toBe(false);
  expect(
    parseCommand(["pr", "list"], {
      CODEX_THREAD_ID: "thread",
      OCTO_MANAGER_AGENT: "0",
    }).output.agent,
  ).toBe(false);
  expect(
    parseCommand(["pr", "list", "--agent"], { OCTO_MANAGER_AGENT: "0" }).output
      .agent,
  ).toBe(true);
  expect(
    parseCommand(["pr", "list"], { OCTO_MANAGER_AGENT: "1" }).values.json,
  ).toBe(true);
  expect(
    parseCommand(["pr", "show", "p", "--full"], { CODEX_THREAD_ID: "thread" })
      .output.full,
  ).toBe(true);
  for (const args of [
    ["pr", "track", "--url", "https://github.com/o/r/pull/1"],
    ["ack", "12345678"],
    ["publication", "retry", "id"],
  ])
    expect(() => parseCommand([...args, "--full"], {})).toThrow("read-only");
  expect(() =>
    parseCommand(["job", "events", "job", "--watch"], {
      OCTO_MANAGER_AGENT: "1",
    }),
  ).toThrow("bounded responses");
});
test("every registered command has a projection or an intentional protocol exception", () => {
  for (const spec of commandSpecs) {
    const projection = agentProjection({
      capability: spec.capability,
      positionals: spec.route.split(" "),
    });
    expect(
      projection !== undefined ||
        agentOutputExceptions[spec.route] !== undefined,
      spec.path,
    ).toBe(true);
  }
});

test("application results keep state, task and completed result without envelopes", () => {
  expect(output(["pause"], { scheduler: "paused" })).toEqual({
    scheduler: "paused",
  });
  expect(output(["resume"], { scheduler: "running" })).toEqual({
    scheduler: "running",
  });
  const task = { kind: "summarize_pr", url: "https://github.com/o/r/pull/1" };
  const result = "Completed summary ".repeat(500);
  expect(
    output(["job", "show", "job"], {
      id: "job",
      task,
      status: "succeeded",
      result,
      attempts: [{ pid: 1 }],
    }),
  ).toEqual({ id: "job", task, status: "succeeded", result });
});

test("tracking keeps independent complete collections and exact identity, links and diagnostics", () => {
  const evidenceUrl = "https://github.com/o/r/pull/1#" + "a".repeat(1000);
  const actions = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    state: "open",
    summary: "A failed check ".repeat(30),
    evidenceUrl,
  }));
  const raw = {
    actions,
    prs: [
      {
        id: "pr",
        ownerAgentId: "owner",
        refreshError: "offline",
        refreshErrorAtMs: 1001,
        observation: {
          observedAtMs: 1000,
          headSha: "head",
          checks: { value: ["untrusted"] },
        },
      },
    ],
    agents: [
      {
        id: "agent",
        target: { sessionId: "session", harness: "codex", endpoint: "local" },
      },
    ],
    attempts: [{ pid: 99 }],
  };
  expect(output(["agent", "status"], raw)).toEqual({
    actions,
    prs: [
      {
        id: "pr",
        ownerAgentId: "owner",
        refreshError: "offline",
        refreshErrorAtMs: 1001,
        observation: { observedAtMs: 1000, headSha: "head" },
      },
    ],
    agents: raw.agents,
  });
  expect(
    JSON.stringify(output(["agent", "status"], raw)).length,
  ).toBeGreaterThan(3000);
  const messages = Array.from({ length: 20 }, (_, i) => ({
    id: `message-${String(i)}`,
    sequence: i + 1,
    applicable: i !== 0,
  }));
  expect(
    output(["agent", "inbox", "--after", "100"], {
      messages,
      nextSequence: 120,
      hasMore: true,
    }),
  ).toEqual({ messages, nextSequence: 120, hasMore: true });
});

test("merge inspection retains the exact target and readiness while omitting transport history", () => {
  const merge = {
    pr: "https://github.com/o/r/pull/1",
    head: "a".repeat(40),
    method: "squash",
  };
  expect(
    output(["message", "receipt"], {
      id: "receipt",
      merge,
      untrustedBody: "historical body",
    }),
  ).toEqual({ id: "receipt", merge });
  const ready = { head: merge.head, source: "owner", baseRef: "main" };
  const entry = {
    id: "entry",
    prId: "pr",
    state: "ready",
    ready,
    checks: ["CI"],
  };
  expect(
    output(["pr", "ready", merge.pr, "--head", merge.head], entry),
  ).toEqual(entry);
  expect(
    output(["pr", "auto-merge", merge.pr, "--on"], {
      prId: "pr",
      enabled: true,
      entry,
    }),
  ).toEqual({ prId: "pr", enabled: true, entry });
  expect(
    output(["chain", "list"], {
      chains: [{ id: "chain", state: "paused" }],
      entries: [entry],
      operations: [],
      dependencies: [],
    }),
  ).toEqual({
    chains: [{ id: "chain", state: "paused" }],
    entries: [entry],
    operations: [],
    dependencies: [],
  });
});
test("agent pagination preserves uint64 cursors beyond the safe integer range", () => {
  expect(
    output(["agent", "inbox"], {
      messages: [
        { id: "message", sequence: 9007199254740993n, applicable: true },
      ],
      nextSequence: 9007199254740993n,
      hasMore: true,
    }),
  ).toEqual({
    messages: [
      { id: "message", sequence: "9007199254740993", applicable: true },
    ],
    nextSequence: "9007199254740993",
    hasMore: true,
  });
});
test("safe action and message projections retain the validated evidence revision", () => {
  const head = "a".repeat(40);
  const action = create(PendingActionSchema, {
    id: "action",
    notificationKind: "review_feedback",
    evidenceHeadSha: head,
  });
  const result = output(
    ["action", "show", "action"],
    create(GetActionResponseSchema, { action }),
  );
  expect(result).toHaveProperty("action.notificationKind", "review_feedback");
  expect(result).toHaveProperty("action.evidenceHeadSha", head);
  const message = create(NotificationMessageSchema, {
    id: "receipt",
    items: [{ id: "member", source: { case: "action", value: { action } } }],
  });
  const inspected = output(
    ["message", "receipt"],
    toJson(NotificationMessageSchema, message),
  );
  expect(inspected).toHaveProperty(
    "items.0.action.action.notificationKind",
    "review_feedback",
  );
  expect(inspected).toHaveProperty(
    "items.0.action.action.evidenceHeadSha",
    head,
  );
});

test("issues preserve titles, full criteria and questions, and continuation state", () => {
  const brief = {
    version: 1,
    outcome: "Working extension",
    criteria: Array.from({ length: 20 }, (_, i) => `Criterion ${String(i)}`),
    questions: ["Which runtime?"],
  };
  const issues = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    title: "Runtime support",
    stage: "ready",
    brief,
  }));
  expect(
    output(["issue", "list", "--offset", "20"], { issues, hasMore: true }),
  ).toEqual({ issues, hasMore: true });
});

test("repairs, activity, participants and archived pages retain their own paging and failure evidence", () => {
  expect(
    output(["conflict", "list", "--after", "10"], {
      cases: [
        {
          id: "11",
          repairId: "repair",
          path: "file",
          decision: "declined",
          reason: "Ambiguous",
          candidate: "raw input",
        },
      ],
      nextId: "11",
    }),
  ).toEqual({
    cases: [
      {
        id: "11",
        repairId: "repair",
        path: "file",
        decision: "declined",
        reason: "Ambiguous",
      },
    ],
    nextId: "11",
  });
  expect(
    output(["repair", "list"], {
      repairs: [
        {
          id: "repair",
          state: "failed",
          detail: "Validation failed",
          originalHead: "head",
          resultHead: "result",
          history: ["old"],
        },
      ],
    }),
  ).toEqual({
    repairs: [
      {
        id: "repair",
        state: "failed",
        detail: "Validation failed",
        originalHead: "head",
        resultHead: "result",
      },
    ],
  });
  const activities = [
    {
      sequence: "1",
      report: {
        operationId: "operation",
        outcome: "uncertain",
        detail: "Missing confirmation",
        evidenceUrl: "https://example.com/evidence",
      },
    },
  ];
  expect(
    output(["activity", "list"], {
      activities,
      events: [],
      nextSequence: "5",
      hasMore: true,
    }),
  ).toEqual({ activities, events: [], nextSequence: "5", hasMore: true });
  const participants = Array.from({ length: 20 }, (_, i) => ({
    agentId: `agent-${String(i)}`,
    role: "observer",
  }));
  expect(
    output(["pr", "participants", "pr", "--after", "20"], {
      participants,
      total: 50,
      hasMore: true,
    }),
  ).toEqual({ participants, total: 50, hasMore: true });
  expect(
    output(["history", "submissions", "--after", "40"], {
      submissions: [
        {
          id: "submission",
          state: "failed",
          detail: "Not published",
          url: "https://github.com/o/r/pull/1",
        },
      ],
      nextBeforeRowId: "20",
    }),
  ).toEqual({
    submissions: [
      {
        id: "submission",
        state: "failed",
        detail: "Not published",
        url: "https://github.com/o/r/pull/1",
      },
    ],
    nextBeforeRowId: "20",
  });
});

test("agent failures preserve diagnostics and structured codes on stderr", () => {
  const write = spyOn(console, "error").mockImplementation(() => {});
  try {
    const message = "Diagnostic detail ".repeat(100);
    printFailure(
      Object.assign(new Error(message), { code: "unavailable" }),
      ["pr", "show", "missing"],
      { OCTO_MANAGER_AGENT: "1" },
    );
    expect(write).toHaveBeenCalledTimes(1);
    const value: unknown = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(value).toEqual({ error: { message, code: "unavailable" } });
  } finally {
    write.mockRestore();
  }
});
