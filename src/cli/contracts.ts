export type Capability =
  | "application"
  | "publication"
  | "tracking"
  | "subscriptions"
  | "notifications"
  | "merging"
  | "repairs"
  | "activity"
  | "history";
export interface Options extends Record<string, string | boolean | undefined> {
  "intent-file"?: string;
  purpose?: string;
  "sample-remote"?: string;
  "sample-count"?: string;
  template?: string;
  title?: string;
  body?: string;
  "body-file"?: string;
  repo?: string;
  head?: string;
  base?: string;
  tier?: string;
  version?: string;
  "policy-version"?: string;
  revision?: string;
  config?: string;
  harness?: string;
  endpoint?: string;
  "thread-id"?: string;
  "agent-id"?: string;
  label?: string;
  cwd?: string;
  state?: string;
  theme?: string;
  timezone?: string;
  "github-hours"?: string;
  model?: string;
  profile?: string;
  url?: string;
  "request-id"?: string;
  after?: string;
  name?: string;
  outcome?: string;
  "operation-id"?: string;
  "harness-version"?: string;
  detail?: string;
  evidence?: string;
  pr?: string;
  prerequisite?: string;
  reason?: string;
  on?: boolean;
  ci?: boolean;
  checks?: string;
  off?: boolean;
  track?: boolean;
  derive?: boolean;
  legacy?: boolean;
  draft?: boolean;
  json?: boolean;
  agent?: boolean;
  full?: boolean;
  "include-acknowledged"?: boolean;
  "applicable-only"?: boolean;
  watch?: boolean;
  help?: boolean;
}
export interface ParsedCommand {
  capability: Capability;
  positionals: string[];
  values: Options;
  output: { agent: boolean; json: boolean; full: boolean };
}
export interface CommandSpec {
  path: string;
  route: string;
  capability: Capability;
  description: string;
  options?: string[];
  hidden?: boolean;
}
