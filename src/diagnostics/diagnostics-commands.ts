import type { CommandSpec } from "../cli/contracts.js";
export const commands: CommandSpec[] = [
  {
    path: "diagnostics capture",
    route: "diagnostics-capture",
    capability: "diagnostics",
    description: "Capture bounded SQLite and scheduler work (off by default)",
    options: ["--seconds <seconds>", "--request-id <id>", "--wait"],
  },
  {
    path: "diagnostics show <id>",
    route: "diagnostics-show",
    capability: "diagnostics",
    description: "Inspect a private performance capture",
  },
  {
    path: "diagnostics stop <id>",
    route: "diagnostics-stop",
    capability: "diagnostics",
    description: "Stop a capture and preserve its partial report",
  },
];
