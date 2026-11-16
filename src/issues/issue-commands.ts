import type { CommandSpec } from "../cli/contracts.js";
const actions = [
  "approve",
  "approve-publication",
  "approve-follow-up",
  "answer",
  "pause",
  "resume",
  "cancel",
  "refresh",
];
export const commands: CommandSpec[] = [
  {
    path: "issue track <url>",
    route: "issue-track",
    capability: "issues",
    description: "Enroll an issue and start investigation",
    options: ["--provider <provider>", "--agent-id <id>", "--request-id <id>"],
  },
  {
    path: "issue list",
    route: "issue-list",
    capability: "issues",
    description: "List managed issues",
    options: ["--offset <offset>"],
  },
  {
    path: "issue show <id>",
    route: "issue-show",
    capability: "issues",
    description: "Inspect an issue and bounded evidence",
    options: ["--before <sequence>"],
  },
  ...actions.map((action) => ({
    path: `issue ${action} <id>`,
    route: `issue-${action}`,
    capability: "issues" as const,
    description: `${action} issue work`,
    options: [
      "--text <text>",
      "--brief-version <version>",
      "--request-id <id>",
    ],
  })),
];
