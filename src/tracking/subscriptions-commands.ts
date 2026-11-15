import type { CommandSpec } from "../cli/contracts.js";
export const commands: CommandSpec[] = [
  {
    path: "pr subscribe <id>",
    route: "subscribe",
    capability: "subscriptions",
    description: "subscribe pull request agents",
    options: [
      "--agent-id <id>",
      "--thread-id <id>",
      "--harness <name>",
      "--endpoint <name>",
      "--label <topic>",
      "--after <cursor>",
    ],
  },
  {
    path: "pr unsubscribe <id>",
    route: "unsubscribe",
    capability: "subscriptions",
    description: "unsubscribe pull request agents",
    options: [
      "--agent-id <id>",
      "--thread-id <id>",
      "--harness <name>",
      "--endpoint <name>",
      "--label <topic>",
      "--after <cursor>",
    ],
  },
  {
    path: "pr participants <id>",
    route: "participants",
    capability: "subscriptions",
    description: "participants pull request agents",
    options: [
      "--agent-id <id>",
      "--thread-id <id>",
      "--harness <name>",
      "--endpoint <name>",
      "--label <topic>",
      "--after <cursor>",
    ],
  },
];
