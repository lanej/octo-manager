import type { CommandSpec } from "../cli/contracts.js";
export const commands: CommandSpec[] = [
  {
    path: "repair rebase",
    route: "rebase",
    capability: "repairs",
    description: "Request an explicit rebase repair",
    options: ["--url <url>", "--profile <name>", "--request-id <id>"],
  },
  {
    path: "repair list",
    route: "repairs",
    capability: "repairs",
    description: "List repair attempts",
  },
  {
    path: "conflict list",
    route: "conflict-cases",
    capability: "repairs",
    description: "List recorded conflicts",
    options: ["--after <cursor>"],
  },
  {
    path: "conflict show <id>",
    route: "conflict-case",
    capability: "repairs",
    description: "Inspect a recorded conflict",
  },
];
