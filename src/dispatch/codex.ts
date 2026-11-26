import type { ThreadSetNameParams } from "../agents/protocol/v2/ThreadSetNameParams.js";
import type { ThreadTurnsListParams } from "../agents/protocol/v2/ThreadTurnsListParams.js";
import type { JsonValue } from "../agents/protocol/serde_json/JsonValue.js";
import { Type } from "typebox";
import { CodexConnection } from "../agents/codex.js";
import type { ThreadStartParams } from "../agents/protocol/v2/ThreadStartParams.js";
import type { ThreadResumeParams } from "../agents/protocol/v2/ThreadResumeParams.js";
import type { TurnStartParams } from "../agents/protocol/v2/TurnStartParams.js";
import { checked } from "../merging/contracts.js";
import { result, ResultSchema, Role, type Assignment } from "../issues/contracts.js";
import type { AgentDispatcher, DispatchStatus } from "../issues/ports.js";

const turnSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  items: Type.Array(
    Type.Object({
      type: Type.String(),
      text: Type.Optional(Type.String()),
      content: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.String(),
            text: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
  ),
});
const threadResponse = Type.Object({
  thread: Type.Object({ id: Type.String() }),
});
const turnsResponse = Type.Object({ data: Type.Array(turnSchema) });

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return value;
  if (Array.isArray(value)) return value.map((item: unknown) => jsonValue(item));
  if (typeof value === "object") {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) output[key] = jsonValue(item);
    return output;
  }
  throw new Error("Invalid output schema value");
}

function strictSchema(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(strictSchema);
  const output: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) output[key] = strictSchema(item);
  const properties = output["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    const required = Array.isArray(output["required"]) ? output["required"] : [];
    for (const [key, property] of Object.entries(properties))
      if (!required.includes(key)) properties[key] = { anyOf: [property ?? null, { type: "null" }] };
    output["additionalProperties"] = false;
    output["required"] = Object.keys(properties);
  }
  return output;
}

function completedResult(text: string) {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid structured result");
  return result(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)));
}

export class CodexDispatcher implements AgentDispatcher {
  readonly harness = "codex";

  constructor(private socket?: string) {}

  async submit(
    assignment: Assignment,
    checkpoint: (sessionId: string) => void,
    signal: AbortSignal,
  ): Promise<DispatchStatus> {
    const connection = new CodexConnection(this.socket);
    try {
      signal.throwIfAborted();
      let sessionId = assignment.sessionId;
      const writable = assignment.role === Role.Implementation;
      if (sessionId.length === 0) {
        const params: ThreadStartParams = {
          model: assignment.profile.model,
          cwd: assignment.workspace,
          approvalPolicy: "never",
          sandbox: writable ? "workspace-write" : "read-only",
          ephemeral: false,
          developerInstructions: assignment.profile.instructions,
        };
        const response = checked(threadResponse, await connection.dispatch("thread/start", params));
        sessionId = response.thread.id;
        checkpoint(sessionId);
      } else {
        const params: ThreadResumeParams = { threadId: sessionId };
        await connection.dispatch("thread/resume", params);
      }
      let namingDetail = "";
      const label = assignment.sessionLabel ?? `Issue ${assignment.role}`;
      const clean = label
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      const characters = Array.from(clean);
      const name = `${characters.slice(0, 80).join("")}${characters.length > 80 ? "…" : ""} · ${sessionId.slice(0, 8)}`;
      const naming: ThreadSetNameParams = { threadId: sessionId, name };
      try {
        await connection.dispatch("thread/name/set", naming);
      } catch (error) {
        // Naming is presentation; a rejected rename must not strand a checkpointed session before dispatch.
        namingDetail = `; session title unavailable: ${error instanceof Error ? error.message.slice(0, 300) : "rename failed"}`;
      }
      checkpoint(sessionId);
      signal.throwIfAborted();
      const params: TurnStartParams = {
        threadId: sessionId,
        cwd: assignment.workspace,
        clientUserMessageId: assignment.id,
        input: [
          {
            type: "text",
            text: `[octo-assignment:${assignment.id}]\n${assignment.prompt}`,
            text_elements: [],
          },
        ],
        model: assignment.profile.model,
        approvalPolicy: "never",
        outputSchema: strictSchema(jsonValue(JSON.parse(JSON.stringify(ResultSchema)))),
        sandboxPolicy: writable
          ? {
              type: "workspaceWrite",
              writableRoots: [assignment.workspace],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: "readOnly", networkAccess: false },
      };
      const started = checked(
        Type.Object({ turn: Type.Object({ id: Type.String() }) }),
        await connection.dispatch("turn/start", params),
      );
      return {
        state: "running",
        sessionId,
        turnId: started.turn.id,
        detail: `Codex accepted assignment${namingDetail}`,
      };
    } finally {
      connection.close();
    }
  }

  async inspect(assignment: Assignment, signal: AbortSignal): Promise<DispatchStatus> {
    if (assignment.sessionId.length === 0)
      return {
        state: "uncertain",
        sessionId: "",
        turnId: "",
        detail: "Thread creation unconfirmed; operator reconciliation required",
      };
    const connection = new CodexConnection(this.socket);
    try {
      signal.throwIfAborted();
      const params: ThreadTurnsListParams = {
        threadId: assignment.sessionId,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      };
      const response = checked(turnsResponse, await connection.dispatch("thread/turns/list", params));
      const turn = response.data.find((value) =>
        assignment.turnId.length > 0
          ? value.id === assignment.turnId
          : value.items.some(
              (item) =>
                item.content?.some((part) => part.text?.includes(`[octo-assignment:${assignment.id}]`) ?? false) ??
                false,
            ),
      );
      if (turn == null)
        return {
          state: "uncertain",
          sessionId: assignment.sessionId,
          turnId: assignment.turnId,
          detail: "Assignment turn not confirmed; do not resubmit",
        };
      if (turn.status === "inProgress")
        return {
          state: "running",
          sessionId: assignment.sessionId,
          turnId: turn.id,
          detail: "Codex running",
        };
      if (turn.status !== "completed")
        return {
          state: "failed",
          sessionId: assignment.sessionId,
          turnId: turn.id,
          detail: `Codex turn ${turn.status}`,
        };
      const output = turn.items.filter((item) => item.type === "agentMessage").at(-1)?.text;
      if (output == null) throw new Error("Completed Codex turn omitted structured result");
      return {
        state: "completed",
        sessionId: assignment.sessionId,
        turnId: turn.id,
        result: completedResult(output),
        detail: "Codex completed; result requires lifecycle validation",
      };
    } finally {
      connection.close();
    }
  }

  async cancel(assignment: Assignment, signal: AbortSignal): Promise<boolean> {
    if (assignment.sessionId.length === 0)
      throw new Error("Cannot confirm cancellation without session and turn identities");
    const status = await this.inspect(assignment, signal);
    if (status.state === "completed" || status.state === "failed") return true;
    if (status.state !== "running") throw new Error("Cancellation remains uncertain; assignment turn not confirmed");
    const connection = new CodexConnection(this.socket);
    try {
      signal.throwIfAborted();
      await connection.dispatch("turn/interrupt", {
        threadId: assignment.sessionId,
        turnId: status.turnId,
      });
      const settled = await this.inspect({ ...assignment, turnId: status.turnId }, signal);
      return settled.state === "completed" || settled.state === "failed";
    } finally {
      connection.close();
    }
  }
}
