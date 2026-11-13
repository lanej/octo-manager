import { join } from "node:path";
import { launchAgent, serviceLabel, shellQuote } from "./config.js";
export interface ServiceInput {
  home: string;
  bun: string;
  release: string;
  state: string;
  path: string;
  configHome: string;
  codexHome: string;
}
export type ServiceDefinition =
  | { kind: "launchd"; file: string; target: string; text: string }
  | { kind: "systemd"; file: string; target: string; text: string };
export interface ServiceResult {
  serviceManager: "launchd" | "systemd" | "manual";
  started: boolean;
  service: string;
  servicePath: string;
  manualCommand?: string;
  reason?: string;
}
export type ServiceRunner = (command: string, args: string[]) => string;
function quote(value: string): string {
  if (/[\r\n]/u.test(value) || value.includes(String.fromCharCode(0)))
    throw new Error("Invalid service value");
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%") +
    '"'
  );
}
function execQuote(value: string): string {
  return quote(value.replaceAll("$", () => "$$"));
}
export function serviceDefinition(
  platform: string,
  input: ServiceInput,
  uid: number,
): ServiceDefinition {
  if (platform === "darwin")
    return {
      kind: "launchd",
      file: join(input.home, "Library/LaunchAgents", serviceLabel + ".plist"),
      target: `gui/${String(uid)}/${serviceLabel}`,
      text: launchAgent(
        input.home,
        input.bun,
        input.release,
        input.state,
        input.path,
        input.configHome,
        input.codexHome,
      ),
    };
  if (platform !== "linux")
    throw new Error("Local installation supports macOS and Linux");
  const environment = {
    HOME: input.home,
    PATH: input.path,
    OCTO_MANAGER_STATE: input.state,
    XDG_CONFIG_HOME: input.configHome,
    CODEX_HOME: input.codexHome,
  };
  return {
    kind: "systemd",
    file: join(input.configHome, "systemd/user/octo-manager.service"),
    target: "octo-manager.service",
    text: `[Unit]\nDescription=Octo Manager\n\n[Service]\nType=simple\nWorkingDirectory=${input.release.replaceAll("%", "%%")}\nExecStart=${[input.bun, join(input.release, "dist/cli.js"), "serve"].map(execQuote).join(" ")}\n${Object.entries(
      environment,
    )
      .map(([key, value]) => `Environment=${quote(key + "=" + value)}`)
      .join(
        "\n",
      )}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`,
  };
}
export async function startService(
  definition: ServiceDefinition,
  input: ServiceInput,
  noStart: boolean,
  run: ServiceRunner,
  managerAvailable: boolean,
): Promise<ServiceResult> {
  const result: ServiceResult = {
    serviceManager: definition.kind,
    service: definition.target,
    servicePath: definition.file,
    started: false,
  };
  const environment = {
    HOME: input.home,
    PATH: input.path,
    OCTO_MANAGER_STATE: input.state,
    XDG_CONFIG_HOME: input.configHome,
    CODEX_HOME: input.codexHome,
  };
  const manualCommand = [
    "/usr/bin/env",
    ...Object.entries(environment).map(([key, value]) => key + "=" + value),
    input.bun,
    join(input.release, "dist/cli.js"),
    "serve",
    "--state",
    input.state,
  ]
    .map(shellQuote)
    .join(" ");
  if (noStart) return { ...result, manualCommand };
  if (!managerAvailable)
    return {
      ...result,
      serviceManager: "manual",
      manualCommand,
      reason:
        "No user service manager is available; launcher and hooks are installed",
    };
  if (definition.kind === "systemd") {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", definition.file]);
    run("systemctl", ["--user", "restart", definition.target]);
    run("systemctl", ["--user", "is-active", "--quiet", definition.target]);
  } else {
    try {
      run("/bin/launchctl", ["print", definition.target]);
      run("/bin/launchctl", ["bootout", definition.target]);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("status" in error) ||
        (error.status !== 3 && error.status !== 113)
      )
        throw error;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        run("/bin/launchctl", [
          "bootstrap",
          definition.target.slice(0, definition.target.lastIndexOf("/")),
          definition.file,
        ]);
        break;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("status" in error) ||
          error.status !== 5 ||
          attempt >= 5
        )
          throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(200 * 2 ** attempt, 1000));
        });
      }
    }
    run("/bin/launchctl", ["enable", definition.target]);
    run("/bin/launchctl", ["kickstart", definition.target]);
    for (let attempt = 0; ; attempt++) {
      if (
        /state = running/u.test(
          run("/bin/launchctl", ["print", definition.target]),
        )
      )
        break;
      if (attempt >= 49) throw new Error("Octo service did not report running");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  return { ...result, started: true };
}
export function managerAvailable(
  definition: ServiceDefinition,
  run: ServiceRunner,
): boolean {
  try {
    if (definition.kind === "systemd")
      run("systemctl", ["--user", "show-environment"]);
    else
      run("/bin/launchctl", [
        "print",
        definition.target.slice(0, definition.target.lastIndexOf("/")),
      ]);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (("code" in error && error.code === "ENOENT") ||
        ("status" in error && typeof error.status === "number"))
    )
      return false;
    throw error;
  }
}
