export function agentMode(explicit: boolean, env: NodeJS.ProcessEnv): boolean {
  if (explicit) return true;
  if (env["OCTO_MANAGER_AGENT"] === "0") return false;
  return (
    env["OCTO_MANAGER_AGENT"] === "1" ||
    (env["CODEX_THREAD_ID"]?.trim().length ?? 0) > 0
  );
}
const reads = new Set([
  "chains",
  "references",
  "dependencies",
  "get",
  "tracked",
  "pr",
  "actions",
  "action",
  "tracking",
  "inbox",
  "digest",
  "digests",
  "participants",
  "activity",
  "repairs",
  "conflict-cases",
  "conflict-case",
  "submission",
  "submissions",
  "events",
]);
export function readOnlyCommand(positionals: string[]): boolean {
  const command = positionals[0] ?? "";
  return (
    reads.has(command) ||
    (command === "repo-policy" &&
      (positionals[1] === "get" || positionals[1] === "template"))
  );
}
