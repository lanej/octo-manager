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
  const methods: string[] = [];
  const ids: number[] = [];
  ws.on("connection", (socket) =>
    socket.on("message", (data) => {
      const m = JSON.parse(data.toString());
      methods.push(m.method);
      if (m.id === undefined) return;
      ids.push(m.id);
      let result: unknown = {};
      if (m.method === "initialize")
        result = {
          userAgent: "codex-tui/0.167.0 (test)",
          codexHome: "/not-real",
          platformFamily: "unix",
          platformOs: "test",
        };
      if (m.method === "thread/read")
        result = { thread: { id: "thread", status: { type: "idle" } } };
      if (m.method === "thread/turns/list")
        result = {
          data: [
            {
              id: "turn",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "[octo-delivery:delivery]" }],
                },
              ],
            },
          ],
          nextCursor: null,
        };
      if (m.method === "turn/start") {
        assert.deepEqual(Object.keys(m.params).sort(), [
          "clientUserMessageId",
          "input",
          "threadId",
        ]);
        assert.equal(m.params.clientUserMessageId, "delivery");
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
    connection.close();
    lose = true;
    connection = new CodexConnection(path);
    await connection.prepare(agent);
    await assert.rejects(
      connection.send(agent, "delivery", "notification"),
      (e) => e instanceof DeliveryError && e.uncertain,
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
