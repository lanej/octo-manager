import { join } from "node:path";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
export function codexHooks(
  value: unknown,
  launcher: string,
  state: string,
): Record<string, unknown> {
  if (!object(value)) throw new Error("Invalid existing Codex hooks file");
  const result = structuredClone(value);
  if (result["hooks"] === undefined) result["hooks"] = {};
  const hooks = result["hooks"];
  if (!object(hooks)) throw new Error("Invalid existing Codex hooks groups");
  const command = `${shellQuote(launcher)} codex-hook --state ${shellQuote(state)}`;
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
    const previous = hooks[event];
    if (previous !== undefined && !Array.isArray(previous))
      throw new Error("Invalid existing Codex hook event");
    const groups: unknown[] = previous === undefined ? [] : previous;
    const exists = groups.some(
      (group) =>
        object(group) &&
        Array.isArray(group["hooks"]) &&
        group["hooks"].some(
          (handler: unknown) =>
            object(handler) &&
            handler["type"] === "command" &&
            handler["command"] === command,
        ),
    );
    if (!exists)
      groups.push({
        ...(event === "PostToolUse"
          ? { matcher: "^(mcp__codex_app__attach_artifact|attach_artifact)$" }
          : {}),
        hooks: [
          { type: "command", command, timeout: 15, additionalContextLimit: 0 },
        ],
      });
    hooks[event] = groups;
  }
  return result;
}
export function desktopConfig(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Invalid Octo configuration");
  const result = structuredClone(value);
  if (result["endpoints"] === undefined) result["endpoints"] = {};
  const endpoints = result["endpoints"];
  if (!object(endpoints)) throw new Error("Invalid Octo endpoints");
  if (endpoints["local"] === undefined) endpoints["local"] = {};
  const local = endpoints["local"];
  if (!object(local)) throw new Error("Invalid local Octo endpoint");
  if (local["delivery"] === undefined) local["delivery"] = "queue";
  return result;
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export const serviceLabel = "com.lanej.octo-manager";
export function launchAgent(
  home: string,
  bun: string,
  release: string,
  state: string,
  path: string,
  configHome?: string,
  codexHome?: string,
): string {
  const environment: Record<string, string> = {
    HOME: home,
    PATH: path,
    OCTO_MANAGER_STATE: state,
    ...(configHome === undefined ? {} : { XDG_CONFIG_HOME: configHome }),
    ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(join(release, "dist", "cli.js"))}</string><string>serve</string></array>
<key>WorkingDirectory</key><string>${xml(release)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, "coordinator.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "coordinator.log"))}</string>
</dict></plist>\n`;
}
