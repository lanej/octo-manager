import WebSocket from "ws";
import { codexVersion, rpcRejection } from "./diagnostics.js";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRef } from "../tracking/types.js";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { ThreadQueueAddParams } from "./protocol/v2/ThreadQueueAddParams.js";
import type { ThreadQueueListParams } from "./protocol/v2/ThreadQueueListParams.js";
import type { ThreadReadParams } from "./protocol/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams.js";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function threadState(value: unknown): unknown {
  if (
    !object(value) ||
    !object(value["thread"]) ||
    !object(value["thread"]["status"])
  )
    return undefined;
  return value["thread"]["status"]["type"];
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly permanent = false,
  ) {
    super(message);
  }
}
export interface AgentAcceptance {
  turnId?: string;
  queueId?: string;
  note?: string;
  received?: boolean;
}
const queueNote = "Accepted by the Codex queue; agent receipt is pending.";
export interface AgentConnection {
  prepare(agent: AgentRef): Promise<{ busy: boolean; version?: string }>;
  send(
    agent: AgentRef,
    deliveryId: string,
    text: string,
  ): Promise<AgentAcceptance>;
  find(
    agent: AgentRef,
    deliveryId: string,
    expectedBody?: string,
  ): Promise<AgentAcceptance & { found: boolean }>;
  close(): void;
}
// WHY: The existing daemon accepts WebSocket frames over its Unix socket; the CLI proxy forwards raw bytes rather than newline JSON.
export class CodexConnection implements AgentConnection {
  private socket: WebSocket;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      method: string;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready: Promise<InitializeResponse>;
  private runtimeVersion: string | undefined;
  constructor(
    socketPath?: string,
    private delivery: "turn" | "queue" = "turn",
  ) {
    const path =
      socketPath ??
      join(
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        "app-server-control",
        "app-server-control.sock",
      );
    this.socket = new WebSocket("ws://localhost", {
      createConnection: () => connect({ path }),
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: 10000,
      perMessageDeflate: false,
    });
    this.socket.on("message", (data) => {
      let m: unknown;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (
        typeof m === "object" &&
        m !== null &&
        "id" in m &&
        typeof m.id === "number"
      ) {
        const p = this.pending.get(m.id);
        if (p === undefined) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if ("error" in m && m.error !== null && m.error !== undefined)
          p.reject(
            new DeliveryError(
              rpcRejection(p.method, m.error, this.runtimeVersion),
              false,
              true,
            ),
          );
        else p.resolve("result" in m ? m.result : undefined);
      }
      // WHY: Notification clients do not answer approval requests. Existing interactive hosts remain responsible.
    });
    this.socket.on("error", () =>
      this.fail(new DeliveryError("Codex connection unavailable")),
    );
    this.socket.on("close", () =>
      this.fail(new DeliveryError("Codex connection closed")),
    );
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () =>
        reject(new DeliveryError("Codex connection unavailable")),
      );
    }).then(async () => {
      const initialize: InitializeParams = {
        clientInfo: {
          name: "octo_manager",
          title: "Octo Manager",
          version: "0.1.0",
        },
        capabilities:
          this.delivery === "queue"
            ? { experimentalApi: true, requestAttestation: false }
            : null,
      };
      const info = await this.call("initialize", initialize);
      this.socket.send(JSON.stringify({ method: "initialized" }));
      this.runtimeVersion = codexVersion(info);
      return info as InitializeResponse;
    });
    void this.ready.catch(() => {});
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  private call(method: string, params: unknown): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new DeliveryError("Codex connection unavailable"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryError("Codex request timed out"));
      }, 10000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new DeliveryError("Codex write failed"));
        }
      });
    });
  }
  async prepare(agent: AgentRef): Promise<{ busy: boolean; version?: string }> {
    const info = await this.ready;
    const version = codexVersion(info);
    if (this.delivery === "queue") {
      const params: ThreadQueueListParams = {
        threadId: agent.sessionId,
        limit: 1,
      };
      const result: unknown = await this.call("thread/queue/list", params);
      if (!object(result) || !Array.isArray(result["data"]))
        throw new DeliveryError("Codex queue unavailable", false, true);
      return { busy: false, ...(version === undefined ? {} : { version }) };
    }
    const read: ThreadReadParams = {
      threadId: agent.sessionId,
      includeTurns: false,
    };
    let result: unknown = await this.call("thread/read", read);
    if (threadState(result) === "notLoaded") {
      const resume: ThreadResumeParams = {
        threadId: agent.sessionId,
        excludeTurns: true,
      };
      await this.call("thread/resume", resume);
      result = await this.call("thread/read", read);
    }
    const state = threadState(result);
    if (state !== "idle" && state !== "active")
      throw new DeliveryError(
        "Codex thread is not available for delivery",
        false,
        true,
      );
    return {
      busy: state === "active",
      ...(version === undefined ? {} : { version }),
    };
  }
  async send(
    agent: AgentRef,
    deliveryId: string,
    text: string,
  ): Promise<AgentAcceptance> {
    if (this.delivery === "queue") return this.enqueue(agent, deliveryId, text);
    const params: TurnStartParams = {
      threadId: agent.sessionId,
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: deliveryId,
    };
    try {
      const result = await this.call("turn/start", params);
      if (typeof result.turn?.id !== "string")
        throw new DeliveryError(
          "Codex acceptance response was incomplete",
          true,
        );
      return { turnId: result.turn.id };
    } catch (error) {
      if (error instanceof DeliveryError && error.permanent) throw error;
      throw new DeliveryError("Codex delivery acceptance is unknown", true);
    }
  }
  private async enqueue(
    agent: AgentRef,
    deliveryId: string,
    text: string,
  ): Promise<{ queueId: string; note: string }> {
    const params: ThreadQueueAddParams = {
      threadId: agent.sessionId,
      clientUserMessageId: deliveryId,
      input: [{ type: "text", text, text_elements: [] }],
    };
    try {
      const result: unknown = await this.call("thread/queue/add", params);
      if (!object(result) || !object(result["queuedSubmission"]))
        throw new DeliveryError("Codex queue receipt is incomplete", true);
      const receipt = result["queuedSubmission"];
      if (
        typeof receipt["id"] !== "string" ||
        receipt["id"] === "" ||
        receipt["clientUserMessageId"] !== deliveryId
      )
        throw new DeliveryError(
          "Codex queue receipt does not match this delivery",
          true,
        );
      return {
        queueId: receipt["id"],
        note: queueNote,
      };
    } catch (error) {
      if (error instanceof DeliveryError && error.permanent) throw error;
      throw new DeliveryError(
        "Codex queue acceptance is unknown; inspect before retrying",
        true,
      );
    }
  }
  async find(
    agent: AgentRef,
    deliveryId: string,
    expectedBody?: string,
  ): Promise<AgentAcceptance & { found: boolean }> {
    await this.ready;
    let queued: AgentAcceptance | undefined;
    if (this.delivery === "queue") {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const params: ThreadQueueListParams = {
          threadId: agent.sessionId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const result: unknown = await this.call("thread/queue/list", params);
        if (!object(result) || !Array.isArray(result["data"]))
          throw new DeliveryError("Codex queue history unavailable");
        const items: unknown[] = result["data"];
        for (const item of items) {
          if (object(item) && item["clientUserMessageId"] === deliveryId) {
            if (typeof item["id"] !== "string" || item["id"] === "")
              throw new DeliveryError("Codex queue receipt is incomplete");
            queued = { queueId: item["id"], note: queueNote };
            if (expectedBody === undefined) return { found: true, ...queued };
            break;
          }
        }
        const next = result["nextCursor"];
        if (next === undefined || next === null || next === "") break;
        if (typeof next !== "string")
          throw new DeliveryError("Codex queue cursor invalid");
        cursor = next;
      }
    }
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: ThreadTurnsListParams = {
        threadId: agent.sessionId,
        limit: 20,
        sortDirection: "desc",
        itemsView: "summary",
        ...(cursor === undefined ? {} : { cursor }),
      };
      const result: unknown = await this.call("thread/turns/list", params);
      if (!object(result) || !Array.isArray(result["data"]))
        throw new DeliveryError("Codex history unavailable");
      const turns: unknown[] = result["data"];
      for (const turn of turns) {
        if (
          object(turn) &&
          typeof turn["id"] === "string" &&
          JSON.stringify(turn["items"] ?? []).includes(
            `[octo-delivery:${deliveryId}]`,
          )
        ) {
          const items: unknown[] = Array.isArray(turn["items"])
            ? turn["items"]
            : [];
          const received =
            expectedBody !== undefined &&
            items.some((item) => {
              if (
                !object(item) ||
                item["type"] !== "userMessage" ||
                !Array.isArray(item["content"])
              )
                return false;
              const content: unknown[] = item["content"];
              return (
                content.length > 0 &&
                content.every(
                  (part) =>
                    object(part) &&
                    part["type"] === "text" &&
                    typeof part["text"] === "string",
                ) &&
                content
                  .map((part) => (object(part) ? part["text"] : ""))
                  .join("") === expectedBody
              );
            });
          if (received)
            return { found: true, turnId: turn["id"], received: true };
          if (expectedBody === undefined)
            return { found: true, turnId: turn["id"] };
        }
      }
      const next = result["nextCursor"];
      if (next === undefined || next === null || next === "")
        return queued === undefined
          ? { found: false }
          : { found: true, ...queued };
      if (typeof next !== "string")
        throw new DeliveryError("Codex history cursor invalid");
      cursor = next;
    }
    return queued === undefined ? { found: false } : { found: true, ...queued };
  }
  close(): void {
    this.fail(new DeliveryError("Codex client closed"));
    this.socket.close();
  }
}
