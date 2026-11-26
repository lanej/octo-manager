import { basename } from "node:path";
import { commandTree, type ParsedCommand } from "./command-tree.js";

export type { ParsedCommand } from "./command-tree.js";

export function parseCommand(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  let parsed: ParsedCommand | undefined;
  commandTree(env, (value) => {
    parsed = value;
  }).parse(args, { from: "user" });
  if (!parsed) throw new Error("Choose a command; see --help");
  return parsed;
}

export function directoryLabel(cwd: string): string {
  return cwd.length <= 200 ? cwd : basename(cwd).slice(0, 200);
}
