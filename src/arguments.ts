import { agentMode, readOnlyCommand } from "./cli-mode.js";
import { basename } from "node:path";
import { parseArgs } from "node:util";

export function parseCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      on: { type: "boolean" },
      off: { type: "boolean" },
      "intent-file": { type: "string" },
      purpose: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      repo: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      tier: { type: "string" },
      version: { type: "string" },
      revision: { type: "string" },
      draft: { type: "boolean" },
      config: { type: "string" },
      harness: { type: "string" },
      endpoint: { type: "string" },
      "thread-id": { type: "string" },
      "agent-id": { type: "string" },
      label: { type: "string" },
      cwd: { type: "string" },
      state: { type: "string" },
      theme: { type: "string" },
      timezone: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      url: { type: "string" },
      "request-id": { type: "string" },
      json: { type: "boolean" },
      agent: { type: "boolean" },
      full: { type: "boolean" },
      "include-acknowledged": { type: "boolean" },
      "applicable-only": { type: "boolean" },
      after: { type: "string" },
      watch: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      name: { type: "string" },
      outcome: { type: "string" },
      "operation-id": { type: "string" },
      "harness-version": { type: "string" },
      detail: { type: "string" },
      evidence: { type: "string" },
    },
  });
  const agent = agentMode(parsed.values.agent === true, env),
    full = parsed.values.full === true;
  if (full && !readOnlyCommand(parsed.positionals))
    throw new Error(
      "--full is available only for read-only inspection commands",
    );
  if (agent && !full && parsed.values.watch === true)
    throw new Error(
      "Agent mode uses bounded responses; inspect events without --watch or explicitly use --full",
    );
  const json = parsed.values.json === true || agent || full;
  return {
    ...parsed,
    values: {
      ...parsed.values,
      state: parsed.values.state ?? env["OCTO_MANAGER_STATE"],
      json,
    },
    output: { agent, json, full },
  };
}

export function directoryLabel(cwd: string): string {
  return cwd.length <= 200 ? cwd : basename(cwd).slice(0, 200);
}
