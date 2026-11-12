import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  copyFile,
  rename,
  symlink,
  rm,
  chmod,
} from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  codexHooks,
  desktopConfig,
  launchAgent,
  serviceLabel,
  shellQuote,
} from "../src/install/config.js";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function run(command: string, args: string[], cwd = source): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 8 * 1024 * 1024,
  });
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (object(error) && error["code"] === "ENOENT") return false;
    throw error;
  }
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (
    !(await lstat(path)).isDirectory() ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new Error(
      `Installation directory is not a regular directory: ${path}`,
    );
  await chmod(path, 0o700);
}
async function atomic(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function json(path: string): Promise<unknown> {
  if (!(await exists(path))) return {};
  if ((await lstat(path)).isSymbolicLink())
    throw new Error(
      `Preserve symlinked configuration; update its source explicitly: ${path}`,
    );
  return JSON.parse(await readFile(path, "utf8"));
}
async function configure(
  path: string,
  value: unknown,
  backup: string,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  if (await exists(path)) {
    const previous = await readFile(path, "utf8");
    if (previous === serialized) return;
    await atomic(backup, previous, 0o600);
  }
  await atomic(path, serialized, 0o600);
}
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      codex: { type: "boolean" },
      "no-start": { type: "boolean" },
    },
  });
  if (process.platform !== "darwin")
    throw new Error(
      "Managed local installation currently supports macOS; use the documented manual coordinator on other platforms",
    );
  if (Bun.version !== "1.4.4")
    throw new Error("Install with the repository's pinned Bun 1.4.4");
  if (run("git", ["status", "--porcelain"]).trim() !== "")
    throw new Error(
      "Commit reviewed source changes before installing a versioned release",
    );
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid source revision");
  const home = resolve(values.home ?? homedir()),
    base = join(home, ".local", "share", "octo-manager"),
    state = resolve(
      process.env["OCTO_MANAGER_STATE"] ??
        join(home, ".local", "state", "octo-manager"),
    );
  const launcher = join(home, ".local", "bin", "octo-manager"),
    release = join(base, "releases", revision),
    bun = join(base, "runtime", "bun-1.4.4", "bun");
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"),
    codexHome = process.env["CODEX_HOME"] ?? join(home, ".codex"),
    hooksPath = join(codexHome, "hooks.json"),
    configPath = join(configHome, "octo-manager", "config.json");
  const hooks =
    values.codex === true
      ? codexHooks(await json(hooksPath), launcher, state)
      : undefined;
  const config =
    values.codex === true ? desktopConfig(await json(configPath)) : undefined;
  const plist = join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  if (
    (await exists(plist)) &&
    !(await readFile(plist, "utf8")).includes(join(base, "releases"))
  )
    throw new Error(
      "An unrecognized service definition exists; preserve it before installing",
    );
  if (
    (await exists(launcher)) &&
    ((await lstat(launcher)).isSymbolicLink() ||
      !(await readFile(launcher, "utf8")).includes("octo-manager"))
  )
    throw new Error(
      "An unrecognized launcher exists; preserve it before installing",
    );
  await privateDirectory(base);
  await privateDirectory(state);
  const lock = join(base, ".install-lock");
  await mkdir(lock, { mode: 0o700 });
  const stage = join(base, "releases", `.install-${randomUUID()}`);
  try {
    await privateDirectory(dirname(release));
    await privateDirectory(dirname(bun));
    if (!(await exists(bun))) {
      await copyFile(process.execPath, bun);
      await chmod(bun, 0o755);
    }
    if (run(bun, ["--version"]).trim() !== "1.4.4")
      throw new Error("Installed private Bun version does not match");
    if (!(await exists(release))) {
      run(process.execPath, ["run", "build"]);
      await privateDirectory(stage);
      await privateDirectory(join(stage, "build"));
      run(process.execPath, [
        "node_modules/typescript/bin/tsc",
        "--outDir",
        join(stage, "dist"),
      ]);
      await copyFile(
        join(source, "build", "octo-manager-tui"),
        join(stage, "build", "octo-manager-tui"),
      );
      await chmod(join(stage, "build", "octo-manager-tui"), 0o755);
      for (const file of ["package.json", "bun.lock"])
        await copyFile(join(source, file), join(stage, file));
      run(
        bun,
        ["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
        stage,
      );
      await writeFile(
        join(stage, "release.json"),
        JSON.stringify({ revision, bun: "1.4.4" }) + "\n",
        { mode: 0o600 },
      );
      await rename(stage, release);
    } else {
      const installed: unknown = JSON.parse(
        await readFile(join(release, "release.json"), "utf8"),
      );
      if (
        !object(installed) ||
        installed["revision"] !== revision ||
        installed["bun"] !== "1.4.4"
      )
        throw new Error("Existing release metadata does not match");
    }
    const current = join(base, "current");
    if ((await exists(current)) && !(await lstat(current)).isSymbolicLink())
      throw new Error("Preserve the non-symlink current installation");
    const temporary = join(base, `.current-${randomUUID()}`);
    await symlink(release, temporary);
    await rename(temporary, current);
    const backups = join(state, "install-backups", revision);
    await privateDirectory(backups);
    if (await exists(launcher))
      await atomic(
        join(backups, "launcher"),
        await readFile(launcher, "utf8"),
        0o600,
      );
    await atomic(
      launcher,
      `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(join(current, "dist", "cli.js"))} "$@"\n`,
      0o755,
    );
    if (hooks !== undefined)
      await configure(hooksPath, hooks, join(backups, "hooks.json"));
    if (config !== undefined)
      await configure(configPath, config, join(backups, "config.json"));
    const gh = run("/usr/bin/which", ["gh"]).trim();
    const path = [
      ...new Set([
        dirname(gh),
        join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]),
    ].join(":");
    await atomic(
      plist,
      launchAgent(home, bun, release, state, path, configHome, codexHome),
      0o600,
    );
    run("/usr/bin/plutil", ["-lint", plist]);
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error("A macOS user service requires a user ID");
    const domain = `gui/${String(uid)}`,
      target = `${domain}/${serviceLabel}`;
    if (values["no-start"] !== true) {
      try {
        run("/bin/launchctl", ["print", target]);
        run("/bin/launchctl", ["bootout", target]);
      } catch {
        /* No registered service on first install. */
      }
      run("/bin/launchctl", ["bootstrap", domain, plist]);
      run("/bin/launchctl", ["enable", target]);
      run("/bin/launchctl", ["kickstart", target]);
    }
    console.log(
      JSON.stringify({
        installed: true,
        revision,
        release,
        launcher,
        state,
        service: target,
        plist,
        started: values["no-start"] !== true,
        codexHooks: hooksPath,
        hookTrust:
          "Review new Octo definitions through Codex /hooks before native activation",
      }),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Local installation failed",
  );
  process.exitCode = 1;
});
