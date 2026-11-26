import { buildNative, validNativeCompiler } from "./build-native.js";
import { serviceDefinition, startService, managerAvailable } from "../src/install/service.js";
import { execFileSync } from "node:child_process";
import {
  IncompleteActivation,
  readCheckpointBinding,
  guardClientPromotion,
  selectedServiceIdentity,
} from "../src/install/activation.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, copyFile, rename, symlink, rm, chmod } from "node:fs/promises";
import { parseArgs } from "node:util";
import { codexHooks, desktopConfig, shellQuote } from "../src/install/config.js";
import { bunRequirement, requireBun } from "../src/runtime.js";

interface StagedRelease {
  schema_version: 1;
  staged: true;
  promoted: boolean | null;
  promotion_state: "not-attempted" | "attempted" | "partial" | "confirmed";
  release_path: string;
  revision: string;
  expected_identity: string;
  bun_requirement: string;
  platform: string;
  architecture: string;
}
let stagedRelease: StagedRelease | undefined;
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
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
    throw new Error(`Installation directory is not a regular directory: ${path}`);
  await chmod(path, 0o700);
}
async function atomic(path: string, content: string, mode: number): Promise<void> {
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
    throw new Error(`Preserve symlinked configuration; update its source explicitly: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}
async function configure(path: string, value: unknown, backup: string): Promise<void> {
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
      "aot-bun": { type: "string" },
      native: { type: "boolean" },
      codex: { type: "boolean" },
      "no-start": { type: "boolean" },
      "stage-only": { type: "boolean" },
    },
  });
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Local installation supports macOS and Linux");
  requireBun(process.versions["bun"]);
  const bun = Bun.which("bun");
  if (bun === null)
    throw new Error(`Octo Manager requires Bun ${bunRequirement} on PATH. Install Bun in the environment.`);
  requireBun(run(bun, ["--version"]).trim());
  if (run("git", ["status", "--porcelain"]).trim() !== "")
    throw new Error("Commit reviewed source changes before installing a versioned release");
  const compiler = values["aot-bun"] ?? process.env["OCTO_AOT_BUN"];
  const native = values.native === true || compiler !== undefined;
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid source revision");
  const home = resolve(values.home ?? homedir()),
    base = join(home, ".local", "share", "octo-manager"),
    state = resolve(process.env["OCTO_MANAGER_STATE"] ?? join(home, ".local", "state", "octo-manager"));
  const launcher = join(home, ".local", "bin", "octo-manager"),
    release = join(
      base,
      "releases",
      process.platform + "-" + process.arch,
      native ? `${revision}-native-aot` : revision,
    );
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"),
    codexHome = process.env["CODEX_HOME"] ?? join(home, ".codex"),
    hooksPath = join(codexHome, "hooks.json"),
    configPath = join(configHome, "octo-manager", "config.json");
  const stageOnly = values["stage-only"] === true;
  const hooks = values.codex === true && !stageOnly ? codexHooks(await json(hooksPath), launcher, state) : undefined;
  const config = values.codex === true && !stageOnly ? desktopConfig(await json(configPath)) : undefined;
  const gh = Bun.which("gh");
  if (gh === null && !stageOnly) throw new Error("Install gh before configuring Octo");
  const path = [
    ...new Set([
      dirname(bun),
      ...(gh === null ? [] : [dirname(gh)]),
      join(home, ".local/bin"),
      ...(process.env["PATH"] ?? "").split(":").filter((value) => value !== ""),
    ]),
  ].join(":");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("A Unix user identity is required");
  const input = {
    home,
    release,
    state,
    path,
    configHome,
    codexHome,
    ...(native ? { executable: join(release, "build/octo-manager") } : {}),
  };
  const definition = serviceDefinition(process.platform, input, uid),
    plist = definition.file;
  const available = stageOnly ? false : managerAvailable(definition, (command, args) => run(command, args));
  if (!stageOnly && (await exists(plist)) && !(await readFile(plist, "utf8")).includes(join(base, "releases")))
    throw new Error("An unrecognized service definition exists; preserve it before installing");
  if (
    !stageOnly &&
    (await exists(launcher)) &&
    ((await lstat(launcher)).isSymbolicLink() || !(await readFile(launcher, "utf8")).includes("octo-manager"))
  )
    throw new Error("An unrecognized launcher exists; preserve it before installing");
  await privateDirectory(base);
  const binding = stageOnly ? undefined : await readCheckpointBinding(process.env);
  const lock = join(base, ".install-lock");
  await mkdir(lock, { mode: 0o700 });
  const stage = join(base, "releases", process.platform + "-" + process.arch, `.install-${randomUUID()}`);
  try {
    await privateDirectory(dirname(release));
    if (!(await exists(release))) {
      if (native && (compiler === undefined || compiler === ""))
        throw new Error(
          "Select the native AOT compiler with --aot-bun PATH or OCTO_AOT_BUN; no interpreted fallback is installed.",
        );
      run(bun, ["run", "build"]);
      const nativeCompiler =
        native && compiler !== undefined ? buildNative(compiler, join(source, "build/octo-manager")) : undefined;
      await privateDirectory(stage);
      await privateDirectory(join(stage, "build"));
      run(bun, ["node_modules/typescript/bin/tsc", "--outDir", join(stage, "dist")]);
      if (native) {
        await copyFile(join(source, "build/octo-manager"), join(stage, "build/octo-manager"));
        await chmod(join(stage, "build/octo-manager"), 0o755);
      }
      for (const file of ["package.json", "bun.lock"]) await copyFile(join(source, file), join(stage, file));
      run(bun, ["install", "--production", "--frozen-lockfile", "--ignore-scripts"], stage);
      await writeFile(
        join(stage, "release.json"),
        JSON.stringify({
          revision,
          format: native ? "native-aot" : "interpreted",
          ...(nativeCompiler === undefined ? {} : { nativeCompiler }),
          bunRequirement,
          platform: process.platform,
          architecture: process.arch,
        }) + "\n",
        { mode: 0o600 },
      );
      await rename(stage, release);
    } else {
      const installed: unknown = JSON.parse(await readFile(join(release, "release.json"), "utf8"));
      if (
        !object(installed) ||
        (native
          ? installed["format"] !== "native-aot" || !validNativeCompiler(installed["nativeCompiler"])
          : installed["format"] === "native-aot") ||
        installed["revision"] !== revision ||
        installed["bunRequirement"] !== bunRequirement ||
        installed["platform"] !== process.platform ||
        installed["architecture"] !== process.arch
      )
        throw new Error("Existing release metadata does not match");
    }
    stagedRelease = {
      schema_version: 1,
      staged: true,
      promoted: false,
      promotion_state: "not-attempted",
      release_path: release,
      revision,
      expected_identity: selectedServiceIdentity(input, (command, args) => run(command, args)),
      bun_requirement: bunRequirement,
      platform: process.platform,
      architecture: process.arch,
    };
    if (stageOnly) {
      console.log(JSON.stringify(stagedRelease));
      return;
    }
    await guardClientPromotion(definition, input, (command, args) => run(command, args), available, binding);
    stagedRelease.promotion_state = "attempted";
    stagedRelease.promoted = null;
    await privateDirectory(state);
    const current = join(base, "current");
    if ((await exists(current)) && !(await lstat(current)).isSymbolicLink())
      throw new Error("Preserve the non-symlink current installation");
    const temporary = join(base, `.current-${randomUUID()}`);
    await symlink(release, temporary);
    await rename(temporary, current);
    stagedRelease.promotion_state = "partial";
    stagedRelease.promoted = true;
    const backups = join(state, "install-backups", revision);
    await privateDirectory(backups);
    if (await exists(launcher)) await atomic(join(backups, "launcher"), await readFile(launcher, "utf8"), 0o600);
    await atomic(
      launcher,
      native
        ? `#!/bin/sh\nexec ${shellQuote(join(current, "build", "octo-manager"))} "$@"\n`
        : `#!/bin/sh\nif ! command -v bun >/dev/null 2>&1; then\n  printf '%s\\n' ${shellQuote(`Octo Manager requires Bun ${bunRequirement} on PATH. Install or upgrade Bun in the environment.`)} >&2\n  exit 1\nfi\nexec bun ${shellQuote(join(current, "dist", "cli.js"))} "$@"\n`,
      0o755,
    );
    if (hooks !== undefined) await configure(hooksPath, hooks, join(backups, "hooks.json"));
    if (config !== undefined) await configure(configPath, config, join(backups, "config.json"));
    await atomic(definition.file, definition.text, 0o600);
    if (definition.kind === "launchd") run("/usr/bin/plutil", ["-lint", definition.file]);
    stagedRelease.promotion_state = "confirmed";
    const service = await startService(
      definition,
      input,
      values["no-start"] === true,
      (command, args) => run(command, args),
      available,
      stagedRelease.expected_identity,
      binding,
    );
    console.log(
      JSON.stringify({
        ...stagedRelease,
        installed: true,
        revision,
        release,
        launcher,
        state,
        ...service,
        ...(definition.kind === "launchd" ? { plist } : {}),
        codexHooks: hooksPath,
        hookTrust: "Review new Octo definitions through Codex /hooks before native activation",
      }),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
main().catch((error: unknown) => {
  if (error instanceof IncompleteActivation) {
    console.log(
      JSON.stringify({
        ...stagedRelease,
        started: false,
        incomplete_activation: true,
        reason: error.message,
      }),
    );
    process.exitCode = 3;
    return;
  }
  if (stagedRelease !== undefined)
    console.log(
      JSON.stringify({
        ...stagedRelease,
        installed: false,
        started: false,
        reason: error instanceof Error ? error.message : "Local installation failed",
      }),
    );
  console.error(error instanceof Error ? error.message : "Local installation failed");
  process.exitCode = 1;
});
