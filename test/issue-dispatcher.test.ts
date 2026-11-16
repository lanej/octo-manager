import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Type } from "typebox";
import { checked } from "../src/merging/contracts.js";
import { CodexDispatcher } from "../src/dispatch/codex.js";
import {
  AttemptState,
  Role,
  type Assignment,
} from "../src/issues/contracts.js";
test("Codex dispatcher checkpoints session before turn and reconciles structured completion", async () => {
  const directory = await mkdtemp("/tmp/octo-issue-ws-");
  const path = join(directory, "socket");
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  const methods: string[] = [];
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
      if (request.method === "thread/start")
        response = { thread: { id: "stage-session" } };
      if (request.method === "turn/start") {
        expect(
          checked(Type.Object({ cwd: Type.String() }), request.params).cwd,
        ).toBe("/fixture");
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
