import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { schedulerClient } from "../client.js";
import { directoryLabel } from "../arguments.js";
import { canonicalPR } from "../tracking/github.js";
import { Handoffs } from "./handoffs.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function artifactResult(value: unknown, url: string): boolean {
  if (!object(value) || value["isError"] === true) return false;
  if (
    value["artifact_type"] === "pull_request" &&
    typeof value["url"] === "string"
  )
    return canonicalPR(value["url"]) === url;
  if (
    object(value["structuredContent"]) &&
    artifactResult(value["structuredContent"], url)
  )
    return true;
  const content: unknown = value["content"];
  if (!Array.isArray(content)) return false;
  const entries: unknown[] = content;
  return entries.some((entry) => {
    if (
      !object(entry) ||
      entry["type"] !== "text" ||
      typeof entry["text"] !== "string"
    )
      return false;
    try {
      return artifactResult(JSON.parse(entry["text"]), url);
    } catch {
      return false;
    }
  });
}
interface HookResult {
  output?: object;
  acknowledge?: () => Promise<void>;
}
function errorDetails(error: unknown, depth = 0): object {
  if (error instanceof Error) {
    const code: unknown = "code" in error ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      ...(error.cause === undefined || depth >= 4
        ? {}
        : { cause: errorDetails(error.cause, depth + 1) }),
    };
  }
  return {
    name: "NonError",
    message: typeof error === "string" ? error : "Non-Error value thrown",
  };
}
async function writeHookDiagnostic(line: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const onError = () => {
      resolve();
    };
    process.stderr.once("error", onError);
    try {
      process.stderr.write(line, (error) => {
        if (error === null || error === undefined)
          process.stderr.off("error", onError);
        resolve();
      });
    } catch {
      process.stderr.off("error", onError);
      resolve();
    }
  });
}
async function logHookError(
  directory: string,
  error: unknown,
  value: unknown,
  phase: "input" | "recovery" | "output" | "receipt",
): Promise<void> {
  const line =
    JSON.stringify({
      at: new Date().toISOString(),
      phase,
      ...(object(value) && typeof value["hook_event_name"] === "string"
        ? { event: value["hook_event_name"].slice(0, 200) }
        : {}),
      ...(object(value) && typeof value["session_id"] === "string"
        ? { sessionId: value["session_id"].slice(0, 200) }
        : {}),
      error: errorDetails(error),
    }) + "\n";
  let diagnostic = line;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(
      join(directory, "codex-hook-errors.jsonl"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new Error("Hook error log must be a regular file");
      await file.chmod(0o600);
      await file.appendFile(line);
    } finally {
      await file.close();
    }
  } catch (loggingError) {
    diagnostic +=
      JSON.stringify({ loggingError: errorDetails(loggingError) }) + "\n";
  }
  await writeHookDiagnostic(diagnostic);
}
export async function codexHook(
  value: unknown,
  directory: string,
): Promise<HookResult> {
  if (!object(value)) throw new Error("Invalid Codex hook input");
  const event = value["hook_event_name"],
    sessionId = value["session_id"],
    cwd = value["cwd"];
  if (
    event !== "SessionStart" &&
    event !== "UserPromptSubmit" &&
    event !== "PostToolUse"
  )
    return {};
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    sessionId.length > 200 ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.length > 4000
  )
    throw new Error("Invalid Codex hook session context");
  const owner = {
    harness: "codex",
    endpoint: "local",
    sessionId,
    label: directoryLabel(cwd),
  };
  const handoffs = new Handoffs(directory);
  if (event === "PostToolUse") {
    if (
      value["tool_name"] !== "mcp__codex_app__attach_artifact" &&
      value["tool_name"] !== "attach_artifact"
    )
      return {};
    const input = value["tool_input"];
    if (
      !object(input) ||
      input["artifact_type"] !== "pull_request" ||
      typeof input["url"] !== "string"
    )
      return {};
    const url = canonicalPR(input["url"]);
    if (!artifactResult(value["tool_response"], url)) return {};
    await handoffs.enqueue(url, owner, cwd);
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: `Octo Manager: monitoring handoff queued for ${url}. The background coordinator will enroll it under this session and return check/review results through the durable inbox. This is queued intake, not confirmation that GitHub checks passed.`,
        },
      },
    };
  }
  const client = schedulerClient(directory),
    deadline = { timeoutMs: 2000 };
  const registered = await client.registerAgent({ target: owner }, deadline);
  const agentId = registered.agent?.id;
  if (agentId === undefined || agentId === "")
    throw new Error("Octo did not confirm agent registration");
  const prompt = value["prompt"];
  const marker =
    event === "UserPromptSubmit" && typeof prompt === "string"
      ? /^\[octo-delivery:([a-f0-9-]{8,36})\]\n/.exec(prompt)?.[1]
      : undefined;
  if (marker !== undefined && typeof prompt === "string") {
    await client.acknowledgeMessage(
      { id: marker, agentId, expectedBody: prompt },
      deadline,
    );
  }
  const digestMarker =
    event === "UserPromptSubmit" && typeof prompt === "string"
      ? /^\[octo-digest:([a-f0-9-]{8,36}):(\d+)\]\n/u.exec(prompt)
      : null;
  if (digestMarker !== null && typeof prompt === "string") {
    await client.acknowledgeAgentDigest(
      {
        id: digestMarker[1] ?? "",
        revision: Number(digestMarker[2]),
        agentId,
        expectedBody: prompt,
      },
      deadline,
    );
  }
  const page = await client.listAgentMessages(
    { agentId, applicableOnly: true },
    deadline,
  );
  const notices: { id: string; body: string }[] = [];
  let bytes = 0;
  for (const message of page.messages) {
    const length = Buffer.byteLength(
      JSON.stringify({ id: message.id, body: message.body }),
    );
    if (!message.applicable || notices.length >= 3 || bytes + length > 32768)
      continue;
    notices.push({ id: message.id, body: message.body });
    bytes += length;
  }
  const status = await handoffs.status(sessionId);
  const lines: string[] = [];
  if (event === "SessionStart")
    lines.push(
      "Octo monitors enrolled PRs and returns actionable evidence through its inbox. Existing task authorization still applies; receipts are tracked automatically. Full evidence: octo-manager action ACTION_ID.",
    );
  if (status.pending.length > 0)
    lines.push(
      `${String(status.pending.length)} PR enrollment handoff(s) remain pending in the durable intake.`,
    );
  if (status.failed.length > 0)
    lines.push(
      `PR enrollment needs attention: ${JSON.stringify(status.failed.slice(0, 5).map((item) => ({ url: item.handoff.url, reason: item.reason })))}`,
    );
  if (notices.length > 0)
    lines.push(notices.map((notice) => notice.body).join("\n\n"));
  const omitted =
    page.messages.filter((message) => message.applicable).length -
    notices.length;
  if (omitted > 0 || page.hasMore)
    lines.push(
      `More unread notifications remain. Retrieve them with octo-manager inbox --agent-id ${agentId} --applicable-only; their receipts have not been recorded by this hook.`,
    );
  if (lines.length === 0) return {};
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: lines.join("\n\n"),
      },
    },
    ...(notices.length === 0
      ? {}
      : {
          acknowledge: async () => {
            for (const notice of notices)
              await client.acknowledgeMessage(
                { id: notice.id, agentId, expectedBody: notice.body },
                deadline,
              );
          },
        }),
  };
}
export async function codexHookCLI(directory: string): Promise<void> {
  let emitted = false;
  let value: unknown;
  let phase: "input" | "recovery" | "output" | "receipt" = "input";
  try {
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4 * 1024 * 1024)
          throw new Error("Codex hook input exceeds its size limit");
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      value = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new SyntaxError("Invalid JSON in Codex hook input");
    }
    phase = "recovery";
    const result = await codexHook(value, directory);
    phase = "output";
    if (result.output !== undefined)
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(JSON.stringify(result.output) + "\n", (error) => {
          if (error !== null && error !== undefined) reject(error);
          else resolve();
        });
      });
    emitted = result.output !== undefined;
    phase = "receipt";
    await result.acknowledge?.();
  } catch (error) {
    await logHookError(directory, error, value, phase);
    const warning =
      "Octo integration could not complete this hook. Do not assume a new PR is monitored; existing handoffs and unread messages are retained.";
    if (emitted) await writeHookDiagnostic(warning + "\n");
    else
      process.stdout.write(JSON.stringify({ systemMessage: warning }) + "\n");
  }
}
