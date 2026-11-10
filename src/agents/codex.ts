import WebSocket from "ws";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRef } from "../tracking/types.js";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { ThreadReadParams } from "./protocol/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams.js";
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly permanent = false,
  ) {
    super(message);
  }
}
export interface AgentConnection {
  prepare(agent: AgentRef): Promise<{ busy: boolean; version?: string }>;
  send(
    agent: AgentRef,
    deliveryId: string,
    text: string,
  ): Promise<{ turnId?: string }>;
  find(
    agent: AgentRef,
    deliveryId: string,
  ): Promise<{ found: boolean; turnId?: string }>;
  close(): void;
}
// WHY: The existing daemon accepts WebSocket frames over its Unix socket; the CLI proxy forwards raw bytes rather than newline JSON.
export class CodexConnection implements AgentConnection {
  private socket: WebSocket;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready: Promise<InitializeResponse>;
  constructor(socketPath?: string) {
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
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error)
          p.reject(
            new DeliveryError(
              "Codex rejected request; check thread availability and app-server compatibility",
              false,
              true,
            ),
          );
        else p.resolve(m.result);
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
        capabilities: null,
      };
      const info = await this.call("initialize", initialize);
      this.socket.send(JSON.stringify({ method: "initialized" }));
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
      this.pending.set(id, { resolve, reject, timer });
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
    const resume: ThreadResumeParams = {
      threadId: agent.sessionId,
      excludeTurns: true,
    };
    await this.call("thread/resume", resume);
    const read: ThreadReadParams = {
      threadId: agent.sessionId,
      includeTurns: false,
    };
    const result = await this.call("thread/read", read);
    const state = result.thread?.status?.type;
    if (!["idle", "active"].includes(state))
      throw new DeliveryError(
        "Codex thread is not available for delivery",
        false,
        true,
      );
    const version = info.userAgent?.match(/\/(\d+\.\d+\.\d+[^ ]*)/)?.[1];
    return { busy: state === "active", ...(version ? { version } : {}) };
  }
  async send(
    agent: AgentRef,
    deliveryId: string,
    text: string,
  ): Promise<{ turnId?: string }> {
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
  async find(
    agent: AgentRef,
    deliveryId: string,
  ): Promise<{ found: boolean; turnId?: string }> {
    await this.ready;
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: ThreadTurnsListParams = {
        threadId: agent.sessionId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      };
      const result = await this.call("thread/turns/list", params);
      if (!Array.isArray(result.data))
        throw new DeliveryError("Codex history unavailable");
      for (const turn of result.data)
        if (
          JSON.stringify(turn.items ?? []).includes(
            `[octo-delivery:${deliveryId}]`,
          )
        )
          return { found: true, turnId: turn.id };
      if (!result.nextCursor) return { found: false };
      cursor = result.nextCursor;
    }
    return { found: false };
  }
  close(): void {
    this.fail(new DeliveryError("Codex client closed"));
    this.socket.close();
  }
}
