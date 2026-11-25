import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { createWorkerRuntime } from "../jobs/auth.js";
import {
  InputSchema,
  inputLimit,
  outputLimit,
  instructions,
} from "./contracts.js";
let started = false;
process.on("disconnect", () => process.exit(1));
process.on("message", (message: unknown) => {
  if (started) return;
  started = true;
  run(message).catch(() => {
    process.send?.({ type: "failure" }, () => process.exit(1));
  });
});
async function run(message: unknown): Promise<void> {
  if (
    typeof message !== "object" ||
    message === null ||
    !("input" in message) ||
    !("model" in message) ||
    typeof message.model !== "string" ||
    !Check(InputSchema, message.input) ||
    Buffer.byteLength(JSON.stringify(message.input)) > inputLimit
  )
    throw new Error("Invalid assessment input");
  const { runtime } = await createWorkerRuntime();
  const model = runtime.getModel("openai-codex", message.model);
  if (model === undefined) throw new Error("Assessment model unavailable");
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resources = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: instructions,
  });
  await resources.reload();
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    resourceLoader: resources,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(),
    tools: [],
    customTools: [],
  });
  let turns = 0;
  let outputBytes = 0;
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      outputBytes += Buffer.byteLength(event.assistantMessageEvent.delta);
      if (outputBytes > outputLimit) process.exit(1);
    }
    if (
      (event.type === "turn_start" && ++turns > 1) ||
      event.type === "tool_execution_start"
    )
      process.exit(1);
  });
  try {
    await session.prompt(JSON.stringify(message.input));
    const last = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      last?.role !== "assistant" ||
      last.stopReason === "error" ||
      last.stopReason === "aborted" ||
      last.stopReason === "length"
    )
      throw new Error("Assessment did not complete");
    const output = session.getLastAssistantText() ?? "";
    if (Buffer.byteLength(output) > outputLimit)
      throw new Error("Oversized assessment output");
    process.send?.({ type: "done", output }, () => process.exit(0));
  } finally {
    session.dispose();
  }
}
