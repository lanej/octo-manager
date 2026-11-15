import type { CommandSpec } from "../cli/contracts.js";
export const commands: CommandSpec[] = [
  {
    path: "history submissions",
    route: "legacy-submissions",
    capability: "history",
    description: "List archived submissions",
    options: ["--after <cursor>"],
  },
  {
    path: "history submission <id>",
    route: "legacy-submission",
    capability: "history",
    description: "Inspect an archived submission",
  },
  {
    path: "history policy <repository>",
    route: "legacy-policy",
    capability: "history",
    description: "Inspect an archived repository policy",
    options: ["--policy-version <version>", "--tier <tier>"],
  },
];
