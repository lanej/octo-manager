import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CodexConnection } from "../src/agents/codex.js";
test("native queue transport confirms withdrawal, preserves opaque content and bounds receipt coverage", async () => {
  const directory = await mkdtemp("/tmp/oc-dws-"),
    path = join(directory, "sock"),
    http = createServer(),
    server = new WebSocketServer({ server: http });
  const methods: string[] = [];
  let repeat = false,
    historyType = "agentMessage",
    longHistory = false;
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString();
      const raw: unknown = JSON.parse(text);
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("id" in raw) ||
        !("method" in raw) ||
        typeof raw.method !== "string"
      )
        return;
      methods.push(raw.method);
      const params =
        "params" in raw && typeof raw.params === "object" && raw.params !== null
          ? raw.params
          : {};
      let result: unknown = {};
      if (raw.method === "initialize")
        result = {
          userAgent: "codex-tui/0.167.1 (test)",
          codexHome: "/synthetic",
          platformFamily: "unix",
          platformOs: "test",
        };
      if (raw.method === "thread/read")
        result = { thread: { id: "thread", status: { type: "active" } } };
      if (raw.method === "thread/queue/list")
        result = {
          data: [
            {
              id: "opaque",
              clientUserMessageId: "foreign",
              input: [{ type: "image", url: "example" }],
            },
          ],
          nextCursor: repeat ? "same" : null,
        };
      if (raw.method === "thread/queue/add")
        result = {
          queuedSubmission: {
            id: "owned",
            clientUserMessageId:
              "clientUserMessageId" in params ? params.clientUserMessageId : "",
            input: "input" in params ? params.input : [],
          },
        };
      if (raw.method === "thread/queue/delete")
        result = {
          deleted:
            "queuedSubmissionId" in params &&
            params.queuedSubmissionId === "owned",
        };
      if (raw.method === "thread/turns/list")
        result = {
          data: [
            {
              id: "turn",
              items: [
                {
                  type: historyType,
                  content: [{ type: "text", text: "exact" }],
                },
              ],
            },
          ],
          nextCursor: longHistory ? String(methods.length) : null,
        };
      socket.send(JSON.stringify({ id: raw.id, result }));
    }),
  );
  await new Promise<void>((resolve) => http.listen(path, resolve));
  const connection = new CodexConnection(path, "queue"),
    agent = {
      id: "agent",
      harness: "codex",
      endpoint: "local",
      sessionId: "thread",
      label: "Synthetic",
      createdAt: 1,
      updatedAt: 1,
    };
  try {
    await connection.prepare(agent);
    expect(await connection.queued(agent)).toEqual([
      { queueId: "opaque", clientId: "foreign" },
    ]);
    expect(await connection.enqueueQueued(agent, "dispatch", "exact")).toEqual({
      queueId: "owned",
      clientId: "dispatch",
      body: "exact",
    });
    expect(await connection.cancelQueued(agent, "owned")).toBe(true);
    expect(await connection.cancelQueued(agent, "consumed")).toBe(false);
    expect(await connection.received(agent, ["exact"])).toEqual({
      bodies: [],
      complete: true,
    });
    historyType = "userMessage";
    expect(await connection.received(agent, ["exact"])).toEqual({
      bodies: ["exact"],
      complete: true,
    });
    longHistory = true;
    expect(await connection.received(agent, ["unseen"])).toEqual({
      bodies: [],
      complete: false,
    });
    repeat = true;
    await connection.queued(agent).then(
      () => {
        throw new Error("Expected incomplete coverage");
      },
      (error: unknown) => {
        expect(String(error)).toContain("cursor");
      },
    );
    expect(methods).not.toContain("thread/queue/update");
    expect(methods).not.toContain("turn/start");
    expect(methods).not.toContain("thread/resume");
  } finally {
    connection.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});
