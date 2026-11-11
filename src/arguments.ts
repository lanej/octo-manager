import { basename } from "node:path";
import { parseArgs } from "node:util";

export function parseCommand(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      harness: { type: "string" },
      endpoint: { type: "string" },
      "thread-id": { type: "string" },
      "agent-id": { type: "string" },
      label: { type: "string" },
      cwd: { type: "string" },
      state: { type: "string" },
      theme: { type: "string" },
      model: { type: "string" },
      url: { type: "string" },
      "request-id": { type: "string" },
      json: { type: "boolean" },
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
}

export function directoryLabel(cwd: string): string {
  return cwd.length <= 200 ? cwd : basename(cwd).slice(0, 200);
}
