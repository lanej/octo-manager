import type { parseCommand } from "./arguments.js";
import { agentMode } from "./cli-mode.js";
import { cliJSON } from "./client.js";
import { compact } from "./tracking/messages.js";
import { agentProjection } from "./cli/agent-output.js";

export function agentResponse(
  parsed: ReturnType<typeof parseCommand>,
  raw: unknown,
): string {
  const project = agentProjection(parsed);
  if (project === undefined) throw new Error("Missing agent output projection");
  const normalized: unknown = JSON.parse(
    JSON.stringify(raw === undefined ? null : raw, (key, value: unknown) => {
      if (typeof value === "bigint" && !Number.isSafeInteger(Number(value)))
        return value.toString();
      return cliJSON(key, value);
    }),
  );
  return JSON.stringify(project(normalized));
}

export function printAgentError(
  message: string,
  code?: string,
  fix?: string,
): void {
  console.error(
    JSON.stringify({
      error: {
        message,
        ...(code === undefined ? {} : { code }),
        ...(fix === undefined ? {} : { fix }),
      },
    }),
  );
}

export function printResult(
  parsed: ReturnType<typeof parseCommand>,
  result: unknown,
): void {
  console.log(
    parsed.output.agent && !parsed.output.full
      ? agentResponse(parsed, result)
      : JSON.stringify(
          result,
          cliJSON,
          parsed.values.json === true ||
            [
              "ack",
              "merge",
              "acknowledge-digest",
              "acknowledge-message",
            ].includes(parsed.positionals[0] ?? "")
            ? undefined
            : 2,
        ),
  );
}
export function printFailure(
  error: unknown,
  args: string[],
  env: NodeJS.ProcessEnv,
): void {
  const message =
    error instanceof Error ? error.message : "CLI operation failed";
  if (agentMode(args.includes("--agent"), env)) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
        ? String(error.code)
        : undefined;
    printAgentError(message, code);
  } else if (args.includes("--json") || args.includes("--full"))
    console.error(
      JSON.stringify({
        ok: false,
        command: compact(args[0] ?? "", 40),
        error: { message: compact(message, 240) },
      }),
    );
  else console.error(message);
}
