import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Type } from "typebox";
import { checked } from "../src/merging/contracts.js";
import { CodexDispatcher } from "../src/dispatch/codex.js";
import { AttemptState, Role, type Assignment } from "../src/issues/contracts.js";
test("Codex dispatcher checkpoints session before turn and reconciles structured completion", async () => {
  const directory = await mkdtemp("/tmp/octo-issue-ws-");
  const path = join(directory, "socket");
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  const methods: string[] = [];
  const names: string[] = [];
  let rejectNaming = false;
  let revokeDuringNaming = false;
  let authorized = true;
  let turnStatus = "completed";
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const content = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString();
      const request = checked(
        Type.Object({
          id: Type.Optional(Type.Number()),
          method: Type.String(),
          params: Type.Optional(Type.Unknown()),
        }),
        JSON.parse(content),
      );
      methods.push(request.method);
      if (request.id === undefined) return;
      let response: unknown = {};
      if (request.method === "initialize")
        response = {
          userAgent: "codex/0.167.1",
          codexHome: "/fixture",
          platformFamily: "unix",
          platformOs: "test",
        };
      if (request.method === "thread/start") response = { thread: { id: "01234567-89ab-cdef-0123-456789abcdef" } };
      if (request.method === "thread/name/set") {
        const params = checked(Type.Object({ threadId: Type.String(), name: Type.String() }), request.params);
        expect(params.threadId).toBe("01234567-89ab-cdef-0123-456789abcdef");
        names.push(params.name);
        if (revokeDuringNaming) authorized = false;
        if (rejectNaming) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32601, message: "Naming unsupported" },
            }),
          );
          return;
        }
      }
      if (request.method === "turn/start") {
        expect(checked(Type.Object({ cwd: Type.String() }), request.params).cwd).toBe("/fixture");
        response = { turn: { id: "stage-turn" } };
      }
      if (request.method === "thread/turns/list")
        response = {
          data: [
            {
              id: "stage-turn",
              status: turnStatus,
              items: [
                {
                  type: "agentMessage",
                  text: JSON.stringify({
                    disposition: "blocked",
                    summary: "Need a fixture",
                    evidence: [],
                    brief: null,
                    prUrl: null,
                    head: null,
                    followUpTitle: null,
                    followUpBody: null,
                  }),
                },
              ],
            },
          ],
        };
      socket.send(JSON.stringify({ id: request.id, result: response }));
    });
  });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  try {
    const assignment: Assignment = {
      id: "assignment",
      sessionLabel: "Investigate owner/repo#42: Fix retries",
      issueId: "issue",
      role: Role.Investigation,
      purpose: "stage",
      briefVersion: 0,
      epoch: 0,
      state: AttemptState.Intended,
      sessionId: "",
      turnId: "",
      workspace: "/fixture",
      profile: {
        harness: "codex",
        model: "configured-model",
        instructions: "Read only",
        timeoutMs: 30000,
      },
      prompt: "Investigate fixture",
      result: undefined,
      createdAt: 0,
      updatedAt: 0,
      detail: "",
    };
    const dispatcher = new CodexDispatcher(path);
    const signal = new AbortController().signal;
    const status = await dispatcher.submit(
      assignment,
      (sessionId) => {
        expect(methods.includes("turn/start")).toBe(false);
        assignment.sessionId = sessionId;
      },
      signal,
    );
    assignment.turnId = status.turnId;
    expect(status.state).toBe("running");
    expect(names).toEqual(["Investigate owner/repo#42: Fix retries · 01234567"]);
    expect(methods.indexOf("thread/name/set")).toBeGreaterThan(methods.indexOf("thread/start"));
    expect(methods.indexOf("thread/name/set")).toBeLessThan(methods.indexOf("turn/start"));
    const completed = await dispatcher.inspect(assignment, signal);
    expect(completed.state).toBe("completed");
    expect(completed.result?.disposition).toBe("blocked");
    expect(completed.result?.brief).toBeUndefined();
    await dispatcher.cancel(assignment, signal);
    expect(methods).not.toContain("turn/interrupt");
    turnStatus = "inProgress";
    expect(await dispatcher.cancel(assignment, signal)).toBe(false);
    expect(methods).toContain("turn/interrupt");
    turnStatus = "interrupted";
    expect(await dispatcher.cancel(assignment, signal)).toBe(true);
    methods.length = 0;
    assignment.sessionLabel = "Test owner/repo#42: Fix retries";
    const resumed = await dispatcher.submit(assignment, () => {}, signal);
    expect(resumed.sessionId).toBe(status.sessionId);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(names.at(-1)).toBe("Test owner/repo#42: Fix retries · 01234567");
    rejectNaming = true;
    methods.length = 0;
    assignment.sessionLabel = `Verify owner/repo#42: \n\u001b${"🙂".repeat(120)}`;
    const unnamed = await dispatcher.submit(assignment, () => {}, signal);
    expect(unnamed.state).toBe("running");
    expect(unnamed.detail).toContain("Naming unsupported");
    expect(methods).toContain("turn/start");
    const boundedName = names.at(-1) ?? "";
    expect(Array.from(boundedName).length).toBeLessThan(100);
    expect(boundedName).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(boundedName.endsWith(" · 01234567")).toBe(true);
    rejectNaming = false;
    revokeDuringNaming = true;
    methods.length = 0;
    await assert.rejects(
      dispatcher.submit(
        assignment,
        () => {
          if (!authorized) throw new Error("Authority revoked during rename");
        },
        signal,
      ),
      /Authority revoked/u,
    );
    expect(methods).toContain("thread/name/set");
    expect(methods).not.toContain("turn/start");
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => {
      sockets.close(() => {
        http.close(() => {
          resolve();
        });
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});
