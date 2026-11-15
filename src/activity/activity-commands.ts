import type { CommandSpec } from "../cli/contracts.js";
export const commands: CommandSpec[] = [
  {
    path: "activity list",
    route: "activity",
    capability: "activity",
    description: "Read the activity log",
    options: ["--after <cursor>"],
  },
  {
    path: "activity record",
    route: "record-activity",
    capability: "activity",
    description: "Record an observed agent operation",
    options: [
      "--name <name>",
      "--outcome <outcome>",
      "--operation-id <id>",
      "--detail <text>",
      "--url <url>",
      "--evidence <url>",
      "--harness-version <version>",
      "--model <model>",
      "--agent-id <id>",
      "--thread-id <id>",
      "--harness <name>",
      "--endpoint <name>",
      "--label <topic>",
      "--request-id <id>",
    ],
  },
];
