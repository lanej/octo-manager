import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CodexConnection, DeliveryError } from "../src/agents/codex.js";

test("Codex Unix WebSocket transport preserves settings and treats lost acceptance as uncertain", async () => {
  // WHY: /tmp exists on both supported systems and keeps the Unix socket below macOS path limits.
  const dir = await mkdtemp("/tmp/oc-ws-"),
    path = join(dir, "sock");
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  let lose = false;
  let rejectMethod = "";
  let readState = "idle";
  let queue: { id: string; clientUserMessageId: string }[] = [];
  let badReceipt = false;
  let queueMode = false;
  let historyType = "userMessage";
  let historyText = "[octo-delivery:delivery]";
  const methods: string[] = [];
  const ids: number[] = [];
  ws.on("connection", (socket) =>
    socket.on("message", (data) => {
      const content = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString();
      const raw: unknown = JSON.parse(content);
      assert(
        typeof raw === "object" &&
          raw !== null &&
          "method" in raw &&
          typeof raw.method === "string",
      );
      const m = {
        method: raw.method,
        id: "id" in raw && typeof raw.id === "number" ? raw.id : undefined,
        params:
          "params" in raw &&
          typeof raw.params === "object" &&
          raw.params !== null
            ? raw.params
            : {},
      };
      methods.push(m.method);
      if (m.id === undefined) return;
      ids.push(m.id);
      if (m.method === rejectMethod) {
        socket.send(
          JSON.stringify({
            id: m.id,
            error: { code: -32601, message: "list_turns is not supported yet" },
          }),
        );
        return;
      }
      let result: unknown = {};
      if (m.method === "initialize") {
        assert.deepEqual(
          "capabilities" in m.params ? m.params.capabilities : undefined,
          queueMode
            ? { experimentalApi: true, requestAttestation: false }
            : null,
        );
        result = {
          userAgent: "codex-tui/0.167.0 (test)",
          codexHome: "/not-real",
          platformFamily: "unix",
          platformOs: "test",
        };
      }
      if (m.method === "thread/queue/list")
        result = { data: queue, nextCursor: null };
      if (m.method === "thread/queue/add") {
        assert.deepEqual(m.params, {
          threadId: "thread",
          clientUserMessageId: "delivery",
          input: [{ type: "text", text: "notification", text_elements: [] }],
        });
        queue = [{ id: "queued", clientUserMessageId: "delivery" }];
        if (lose) {
          socket.terminate();
          return;
        }
        result = {
          queuedSubmission: badReceipt
            ? { id: "wrong", clientUserMessageId: "other" }
            : queue[0],
        };
      }
      if (m.method === "thread/read")
        result = { thread: { id: "thread", status: { type: readState } } };
      if (m.method === "thread/resume") readState = "idle";
      if (m.method === "thread/turns/list") {
        assert.equal(
          "itemsView" in m.params ? m.params.itemsView : undefined,
          "summary",
        );
        result = {
          data: [
            {
              id: "turn",
              items: [
                {
                  type: historyType,
                  content: [{ type: "text", text: historyText }],
                },
              ],
            },
          ],
          nextCursor: null,
        };
      }
      if (m.method === "turn/start") {
        assert.deepEqual(Object.keys(m.params).sort(), [
          "clientUserMessageId",
          "input",
          "threadId",
        ]);
        assert.equal(
          "clientUserMessageId" in m.params
            ? m.params.clientUserMessageId
            : undefined,
          "delivery",
        );
        if (lose) {
          socket.terminate();
          return;
        }
        result = { turn: { id: "turn" } };
      }
      socket.send(JSON.stringify({ id: m.id, result }));
    }),
  );
  await new Promise<void>((resolve) => http.listen(path, resolve));
  const agent = {
    id: "agent",
    harness: "codex",
    endpoint: "local",
    sessionId: "thread",
  };
  let connection = new CodexConnection(path);
  try {
    assert.deepEqual(await connection.prepare(agent), {
      busy: false,
      version: "0.167.0",
    });
    assert.deepEqual(
      await connection.send(agent, "delivery", "[octo-delivery:delivery]"),
      { turnId: "turn" },
    );
    assert.deepEqual(await connection.find(agent, "delivery"), {
      found: true,
      turnId: "turn",
    });
    assert.deepEqual(await connection.find(agent, "delivery", historyText), {
      found: true,
      turnId: "turn",
      received: true,
    });
    historyType = "agentMessage";
    assert.deepEqual(await connection.find(agent, "delivery", historyText), {
      found: false,
    });
    historyType = "userMessage";
    historyText += " altered";
    assert.deepEqual(
      await connection.find(agent, "delivery", "[octo-delivery:delivery]"),
      { found: false },
    );
    historyText = "[octo-delivery:delivery]";
    connection.close();
    methods.length = 0;
    readState = "active";
    connection = new CodexConnection(path);
    assert.deepEqual(await connection.prepare(agent), {
      busy: true,
      version: "0.167.0",
    });
    assert(!methods.includes("thread/resume"));
    assert(!methods.includes("turn/start"));
    connection.close();
    readState = "notLoaded";
    connection = new CodexConnection(path);
    assert.deepEqual(await connection.prepare(agent), {
      busy: false,
      version: "0.167.0",
    });
    assert(methods.includes("thread/resume"));
    connection.close();
    for (const method of ["thread/resume", "turn/start"]) {
      rejectMethod = method;
      readState = method === "thread/resume" ? "notLoaded" : "idle";
      connection = new CodexConnection(path);
      if (method === "turn/start") await connection.prepare(agent);
      await assert.rejects(
        method === "thread/resume"
          ? connection.prepare(agent)
          : connection.send(agent, "delivery", "notification"),
        (error) =>
          error instanceof DeliveryError &&
          error.permanent &&
          !error.uncertain &&
          error.message.includes(method) &&
          error.message.includes("-32601") &&
          error.message.includes("0.167.0") &&
          error.message.includes("list_turns is not supported yet"),
      );
      connection.close();
    }
    rejectMethod = "";
    lose = true;
    connection = new CodexConnection(path);
    await connection.prepare(agent);
    await assert.rejects(
      connection.send(agent, "delivery", "notification"),
      (e) => e instanceof DeliveryError && e.uncertain,
    );
    connection.close();
    lose = false;
    methods.length = 0;
    queueMode = true;
    connection = new CodexConnection(path, "queue");
    await connection.prepare(agent);
    const accepted = {
      queueId: "queued",
      note: "Accepted by the Codex queue; agent receipt is pending.",
    };
    assert.deepEqual(
      await connection.send(agent, "delivery", "notification"),
      accepted,
    );
    assert.deepEqual(await connection.find(agent, "delivery"), {
      found: true,
      ...accepted,
    });
    assert(!methods.includes("thread/resume"));
    assert(!methods.includes("turn/start"));
    connection.close();
    for (const invalid of [false, true]) {
      lose = !invalid;
      badReceipt = invalid;
      queue = [];
      connection = new CodexConnection(path, "queue");
      await connection.prepare(agent);
      await assert.rejects(
        connection.send(agent, "delivery", "notification"),
        (error) =>
          error instanceof DeliveryError && error.uncertain && !error.permanent,
      );
      connection.close();
      connection = new CodexConnection(path, "queue");
      await connection.prepare(agent);
      const adds = methods.filter(
        (method) => method === "thread/queue/add",
      ).length;
      assert.deepEqual(await connection.find(agent, "delivery"), {
        found: true,
        ...accepted,
      });
      assert.equal(
        methods.filter((method) => method === "thread/queue/add").length,
        adds,
      );
      connection.close();
    }
    lose = false;
    rejectMethod = "thread/queue/list";
    connection = new CodexConnection(path, "queue");
    await assert.rejects(
      connection.prepare(agent),
      (error) =>
        error instanceof DeliveryError && error.permanent && !error.uncertain,
    );
    assert(methods.includes("initialized"));
    assert(ids.every(Number.isInteger));
  } finally {
    connection.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
