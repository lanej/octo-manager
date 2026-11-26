export function agentMode(explicit: boolean, env: NodeJS.ProcessEnv): boolean {
  if (explicit) return true;
  if (env["OCTO_MANAGER_AGENT"] === "0") return false;
  return env["OCTO_MANAGER_AGENT"] === "1" || (env["CODEX_THREAD_ID"]?.trim().length ?? 0) > 0;
}
const reads = new Set([
  "diagnostics-show",
  "issue-list",
  "issue-show",
  "chains",
  "references",
  "dependencies",
  "get",
  "tracked",
  "pr",
  "actions",
  "action",
  "assessment",
  "tracking",
  "inbox",
  "agents",
  "digest",
  "message",
  "digests",
  "participants",
  "activity",
  "repairs",
  "conflict-cases",
  "conflict-case",
  "submission",
  "submissions",
  "events",
  "legacy-submissions",
  "legacy-submission",
  "legacy-policy",
]);
export function readOnlyCommand(positionals: string[]): boolean {
  const command = positionals[0] ?? "";
  if (command === "pr" && ["init", "refresh"].includes(positionals[1] ?? "")) return false;
  if (command === "pr" && ["init", "refresh", "validate"].includes(positionals[1] ?? "")) return false;
  return (
    reads.has(command) || (command === "repo-policy" && (positionals[1] === "get" || positionals[1] === "template"))
  );
}
