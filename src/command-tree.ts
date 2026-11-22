import { commands as issueCommands } from "./issues/issue-commands.js";
import { commands as applicationCommands } from "./cli/application-commands.js";
import { commands as publicationCommands } from "./publication/publication-commands.js";
import { commands as trackingCommands } from "./tracking/tracking-commands.js";
import { commands as subscriptionsCommands } from "./tracking/subscriptions-commands.js";
import { commands as notificationsCommands } from "./notifications/notifications-commands.js";
import { commands as mergingCommands } from "./merging/merging-commands.js";
import { commands as repairsCommands } from "./repairs/repairs-commands.js";
import { commands as activityCommands } from "./activity/activity-commands.js";
import { commands as historyCommands } from "./submissions/history-commands.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  Command,
  Option,
  CommanderError,
  InvalidArgumentError,
} from "commander";
import { agentMode, readOnlyCommand } from "./cli-mode.js";
import type { CommandSpec, ParsedCommand, Options } from "./cli/contracts.js";
export type { ParsedCommand } from "./cli/contracts.js";
const identity = [
  "--agent-id <id>",
  "--thread-id <id>",
  "--harness <name>",
  "--endpoint <name>",
  "--label <topic>",
];
const request = ["--request-id <id>"];
const publication = [
  "--title <title>",
  "--body <text>",
  "--body-file <path>",
  "--repo <repository>",
  "--head <branch>",
  "--base <branch>",
  "--draft",
  "--track",
  "--no-track",
  ...identity,
  ...request,
];
export const commandSpecs: CommandSpec[] = [
  ...issueCommands,
  ...applicationCommands,
  ...publicationCommands,
  ...trackingCommands,
  ...subscriptionsCommands,
  ...notificationsCommands,
  ...mergingCommands,
  ...repairsCommands,
  ...activityCommands,
  ...historyCommands,
];
// These forms occur in durable notices or installed hook definitions.
const compatibility: CommandSpec[] = [
  {
    path: "submit-pr",
    route: "submit-pr",
    capability: "publication",
    description: "Publication hook entrypoint",
    options: publication,
  },
  {
    path: "track",
    route: "track",
    capability: "tracking",
    description: "Tracking hook entrypoint",
    options: ["--url <url>", ...identity],
  },
  {
    path: "acknowledge-digest <id>",
    route: "acknowledge-digest",
    capability: "notifications",
    description: "Stored digest receipt",
    options: ["--revision <revision>", ...identity],
  },
  {
    path: "acknowledge-message <id>",
    route: "acknowledge-message",
    capability: "notifications",
    description: "Stored message receipt",
    options: identity,
  },
  {
    path: "submission <id>",
    route: "submission",
    capability: "publication",
    description: "Stored publication inspection",
  },
];
function integer(value: string): string {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Expected a nonnegative safe integer");
  return value;
}
export function commandTree(
  env: NodeJS.ProcessEnv,
  execute: (parsed: ParsedCommand) => void | Promise<void>,
  output?: {
    writeOut?: (value: string) => void;
    writeErr?: (value: string) => void;
  },
): Command {
  const root = new Command()
    .configureOutput({ writeErr: () => {}, ...output })
    .name("octo-manager")
    .description("Track pull requests and coordinate agent work")
    .version("0.1.0")
    .exitOverride();
  root
    .option("--state <directory>", "Coordinator state directory")
    .option("--cwd <directory>", "Caller working directory")
    .option("--json", "Structured output")
    .option("--agent", "Bounded agent output")
    .option("--full", "Full read-only inspection");
  const groups = new Map<string, Command>();
  for (const spec of [
    ...commandSpecs,
    ...compatibility.map((s) => ({ ...s, hidden: true })),
  ]) {
    const words = spec.path.split(" ");
    let parent = root;
    for (
      let i = 0;
      i < words.length - 1 &&
      !(words[i + 1] ?? "").startsWith("<") &&
      !(words[i + 1] ?? "").startsWith("[");
      i++
    ) {
      const prefix = words.slice(0, i + 1).join(" ");
      let group = groups.get(prefix);
      if (group === undefined) {
        group = parent
          .command(words[i] ?? "")
          .description(`${prefix} commands`);
        groups.set(prefix, group);
      }
      parent = group;
    }
    const consumed = parent === root ? 0 : parent.name().split(" ").length;
    const groupDepth =
      [...groups].find(([, c]) => c === parent)?.[0].split(" ").length ??
      consumed;
    const command = parent
      .command(words.slice(groupDepth).join(" "), {
        hidden: spec.hidden ?? false,
      })
      .description(spec.description);
    for (const flags of spec.options ?? []) {
      const option = new Option(
        flags,
        flags.split(" ")[0]?.replace(/^--/u, "").replaceAll("-", " "),
      );
      if (
        /--(?:after|revision|version|policy-version|sample-count|github-hours)\b/u.test(
          flags,
        )
      )
        option.argParser(integer);
      if (flags === "--on") option.conflicts("off");
      if (flags === "--off") option.conflicts("on");
      const required: Record<string, string[]> = {
        track: ["url"],
        "submit summarize-pr": ["url"],
        rebase: ["url", "profile", "request-id"],
        "merge-ready": ["head"],
        "queue-chain": ["intent-file"],
        "dependency-confirm": ["pr", "prerequisite", "reason"],
        "record-activity": [
          "name",
          "outcome",
          "operation-id",
          "request-id",
          "detail",
        ],
      };
      if (
        required[spec.route]?.includes(flags.split(" ")[0]?.slice(2) ?? "") ===
        true
      )
        option.makeOptionMandatory();
      if (flags === "--theme <theme>")
        option.choices(["terminal", "dark", "light", "contrast", "mono"]);
      if (flags === "--outcome <outcome>")
        option.choices(["attempted", "succeeded", "failed", "uncertain"]);
      if (flags === "--tier <tier>")
        option.choices(["routine", "standard", "complex"]);
      command.addOption(option);
    }
    command.action((...args: unknown[]) => {
      const values: Options = {};
      const options: unknown = command.optsWithGlobals();
      if (typeof options !== "object" || options === null)
        throw new Error("Invalid command options");
      const entries: [string, unknown][] = Object.entries(options);
      for (const [key, value] of entries) {
        if (
          typeof value !== "string" &&
          typeof value !== "boolean" &&
          value !== undefined
        )
          throw new Error("Invalid option value");
        values[key.replace(/[A-Z]/gu, (c) => "-" + c.toLowerCase())] = value;
      }
      const positionals = [
        ...spec.route.split(" "),
        ...args
          .slice(0, command.registeredArguments.length)
          .filter((v): v is string => typeof v === "string"),
      ];
      const agent = agentMode(values.agent === true, env),
        full = values.full === true;
      if (full && !readOnlyCommand(positionals))
        throw new Error(
          "--full is available only for read-only inspection commands",
        );
      if (agent && !full && values.watch === true)
        throw new Error(
          "Agent mode uses bounded responses; inspect events without --watch or explicitly use --full",
        );
      const json = values.json === true || agent || full;
      values.state = resolve(
        values.state ??
          env["OCTO_MANAGER_STATE"] ??
          join(homedir(), ".local/state/octo-manager"),
      );
      const environmentThread = env["CODEX_THREAD_ID"],
        environmentAgent = env["OCTO_MANAGER_AGENT_ID"];
      if (values["thread-id"] === undefined && environmentThread !== undefined)
        values["thread-id"] = environmentThread;
      if (
        values["agent-id"] === undefined &&
        environmentAgent !== undefined &&
        environmentAgent.trim() !== ""
      )
        values["agent-id"] = environmentAgent;
      values.json = json;
      return execute({
        capability: spec.capability,
        positionals,
        values,
        output: { agent, json, full },
      });
    });
  }
  return root;
}
export { CommanderError };

export function displayArguments(args: string[]): string[] {
  const candidates = commandSpecs
    .filter((spec) =>
      spec.route.split(" ").every((word, index) => args[index] === word),
    )
    .sort((a, b) => b.route.length - a.route.length);
  const spec = candidates[0];
  if (spec === undefined) return args;
  return [
    ...spec.path
      .split(" ")
      .filter((word) => !word.startsWith("<") && !word.startsWith("[")),
    ...args.slice(spec.route.split(" ").length),
  ];
}
