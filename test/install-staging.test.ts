import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  copyFile,
  chmod,
  symlink,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { serviceDefinition } from "../src/install/service.js";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { wireLifecycle } from "../src/lifecycle-rpc.js";
import { schedulerClient } from "../src/client.js";
import type { ActivationTarget } from "../src/lifecycle.js";
import { LifecycleAction } from "../src/gen/octomanager/v2/lifecycle_pb.js";
import { SchedulerService } from "../src/gen/octomanager/v2/scheduler_pb.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function installerFixture() {
  const root = await mkdtemp("/tmp/octo-install-staging-"),
    source = join(root, "project"),
    home = join(root, "home"),
    state = join(root, "state"),
    bin = join(root, "bin"),
    configHome = join(home, ".config"),
    codexHome = join(home, ".codex"),
    base = join(home, ".local/share/octo-manager"),
    current = join(base, "current"),
    legacy = join(base, "releases", "legacy"),
    launcher = join(home, ".local/bin/octo-manager"),
    hooks = join(codexHome, "hooks.json"),
    config = join(configHome, "octo-manager/config.json");
  for (const path of [
    join(source, "scripts"),
    join(source, "build"),
    join(source, "fixture-dist"),
    state,
    bin,
    legacy,
    codexHome,
    join(configHome, "octo-manager"),
    join(home, ".local/bin"),
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const input = {
      home,
      state,
      release: legacy,
      path: bin,
      configHome,
      codexHome,
    },
    uid = process.getuid?.();
  assert(uid !== undefined);
  const definition = serviceDefinition(process.platform, input, uid);
  await mkdir(resolve(definition.file, ".."), { recursive: true });
  await writeFile(definition.file, definition.text, { mode: 0o600 });
  await writeFile(launcher, "#!/bin/sh\n# octo-manager legacy fixture\n", {
    mode: 0o755,
  });
  await writeFile(hooks, '{"hooks":{}}\n', { mode: 0o600 });
  await writeFile(config, '{"endpoints":{}}\n', { mode: 0o600 });
  await symlink(legacy, current);
  for (const name of ["package.json", "bun.lock"])
    await copyFile(resolve(name), join(source, name));
  for (const [entry, output] of [
    ["scripts/install-local.ts", "scripts"],
    ["src/cli.ts", "fixture-dist"],
  ]) {
    assert(entry !== undefined && output !== undefined);
    const built = await Bun.build({
      entrypoints: [resolve(entry)],
      target: "bun",
      outdir: join(source, output),
      plugins:
        entry === "scripts/install-local.ts"
          ? [
              {
                name: "private-fixture-manager-boundary",
                setup(builder) {
                  builder.onLoad(
                    { filter: /install-local\.ts$/ },
                    async (args) => ({
                      contents: (
                        'import { readFileSync as fixtureReadFileSync, appendFileSync as fixtureAppendFileSync } from "node:fs";\n' +
                        (await readFile(args.path, "utf8"))
                      ).replace(
                        "  return execFileSync(command, args, {",
                        '  if (command === "/bin/launchctl") {\n    const report = process.env["OCTO_TEST_MANAGER_REPORT"];\n    if (report === undefined) throw Object.assign(new Error("No fixture manager"), {status: 113});\n    if (args[0] === "print") return fixtureReadFileSync(report, "utf8");\n    const ledger = process.env["OCTO_TEST_MANAGER_MUTATIONS"];\n    if (ledger !== undefined) fixtureAppendFileSync(ledger, JSON.stringify([command, ...args]) + String.fromCharCode(10));\n    throw new Error("Fixture refuses mutative OS control");\n  }\n  return execFileSync(command, args, {',
                      ),
                      loader: "ts",
                      resolveDir: resolve(args.path, ".."),
                    }),
                  );
                },
              },
            ]
          : [],
    });
    expect(built.success).toBe(true);
  }
  await writeFile(
    join(source, "build/octo-manager-tui"),
    "fixture executable\n",
  );
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "--quiet",
    "-m",
    "Fixture",
  ]);
  const runtime = process.execPath;
  await writeFile(
    join(bin, "bun"),
    `#!${runtime}
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log(process.versions.bun);}
else if(args[0]==='run'&&args[1]==='build'){}
else if(args[0]==='node_modules/typescript/bin/tsc'){cpSync(join(process.cwd(),'fixture-dist'),args[2],{recursive:true});}
else if(args[0]==='install'){mkdirSync(join(process.cwd(),'node_modules'));}
else if(args[1]==='lifecycle'&&args[2]==='artifact'&&process.env.OCTO_TEST_ARTIFACT_SEQUENCE){const path=process.env.OCTO_TEST_ARTIFACT_SEQUENCE;const value=JSON.parse(readFileSync(path,'utf8'));const identity=value.identities[Math.min(value.index,value.identities.length-1)];value.index++;writeFileSync(path,JSON.stringify(value));console.log(JSON.stringify({expected_identity:identity}));}
else {const child=Bun.spawn([${JSON.stringify(runtime)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;}
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(bin, "systemctl"),
    `#!${runtime}
import { readFileSync, appendFileSync } from 'node:fs';
const args=process.argv.slice(2), report=process.env.OCTO_TEST_MANAGER_REPORT;
if(report&&args[1]==='show'){console.log(readFileSync(report,'utf8'));}
else if(report&&args[1]!=='show-environment'){const ledger=process.env.OCTO_TEST_MANAGER_MUTATIONS;if(ledger)appendFileSync(ledger,JSON.stringify(args)+String.fromCharCode(10));process.exitCode=1;}
else console.log(['LoadState=not-found','ActiveState=inactive','MainPID=0'].join(String.fromCharCode(10)));
`,
    { mode: 0o755 },
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: bin + ":" + (process.env["PATH"] ?? ""),
    OCTO_MANAGER_STATE: state,
    XDG_CONFIG_HOME: configHome,
    CODEX_HOME: codexHome,
  };
  delete environment["PROJECT_UPDATE_OPERATION_DIR"];
  delete environment["PROJECT_UPDATE_RUN_ID"];
  async function install(flag?: string) {
    const child = Bun.spawn(
      [
        runtime,
        join(source, "scripts/install-local.js"),
        "--home",
        home,
        "--codex",
        ...(flag === undefined ? [] : [flag]),
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text(),
      stderr = await new Response(child.stderr).text();
    return { status: await child.exited, stdout, stderr };
  }
  return {
    root,
    state,
    base,
    current,
    legacy,
    launcher,
    hooks,
    config,
    definition,
    environment,
    install,
  };
}

test("installer preserves legacy consumers and reports partial promotion after an acknowledged current change", async () => {
  const {
    root,
    state,
    base,
    current,
    legacy,
    launcher,
    hooks,
    config,
    definition,
    install,
  } = await installerFixture();
  let requests = 0,
    legacyReads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/octomanager.v1.SchedulerService/GetSnapshot") {
      legacyReads++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    requests++;
    assert.equal(request.url, "/octomanager.v2.SchedulerService/GetServerInfo");
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ code: "unimplemented", message: "Legacy v1 fixture" }),
    );
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(join(state, "run.sock"), () => {
      server.off("error", reject);
      done();
    });
  });
  await chmod(join(state, "run.sock"), 0o600);
  async function legacyRead(): Promise<string> {
    return await new Promise<string>((done, reject) => {
      const request = httpRequest(
        {
          socketPath: join(state, "run.sock"),
          path: "/octomanager.v1.SchedulerService/GetSnapshot",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            if (response.statusCode === 200) done(body);
            else reject(new Error("Legacy read stopped working"));
          });
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
  }
  const paths = [launcher, hooks, config, definition.file],
    contents = await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    stateBefore = await stat(state);
  try {
    expect(await legacyRead()).toBe("{}");
    const staged = await install("--stage-only");
    assert.equal(staged.status, 0, staged.stderr);
    const receipt: unknown = JSON.parse(staged.stdout);
    assert(record(receipt));
    expect(receipt["schema_version"]).toBe(1);
    expect(receipt["staged"]).toBe(true);
    expect(receipt["promoted"]).toBe(false);
    expect(receipt["promotion_state"]).toBe("not-attempted");
    expect(receipt["expected_identity"]).toMatch(/^[a-f0-9]{64}$/u);
    assert(typeof receipt["release_path"] === "string");
    expect(
      receipt["release_path"].startsWith(join(base, "releases") + "/"),
    ).toBe(true);
    expect(await readlink(current)).toBe(legacy);
    expect(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    ).toEqual(contents);
    expect(await readdir(state)).toEqual(["run.sock"]);
    expect((await stat(state)).ctimeMs).toBe(stateBefore.ctimeMs);
    expect(requests).toBe(0);
    const blocked = await install("--no-start");
    assert.equal(blocked.status, 3, blocked.stderr);
    const refusal: unknown = JSON.parse(blocked.stdout);
    assert(record(refusal));
    expect(refusal["promoted"]).toBe(false);
    expect(refusal["promotion_state"]).toBe("not-attempted");
    expect(refusal["reason"]).toBe(
      "native-client-promotion-api-incompatible-or-unavailable",
    );
    expect(await readlink(current)).toBe(legacy);
    expect(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    ).toEqual(contents);
    expect(await readdir(state)).toEqual(["run.sock"]);
    expect(requests).toBe(1);
    expect(server.listening).toBe(true);
    expect(await legacyRead()).toBe("{}");
    expect(legacyReads).toBe(2);
    await new Promise<void>((done, reject) => {
      server.close((error) => {
        if (error === undefined) done();
        else reject(error);
      });
    });
    await writeFile(
      join(state, "install-backups"),
      "Fixture blocks backup directory creation",
    );
    const partial = await install("--no-start");
    assert.equal(partial.status, 1);
    const failed: unknown = JSON.parse(partial.stdout);
    assert(record(failed));
    expect(await readlink(current)).toBe(receipt["release_path"]);
    expect(await readlink(current)).not.toBe(legacy);
    expect(failed["promoted"]).toBe(true);
    expect(failed["promotion_state"]).toBe("partial");
    expect(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    ).toEqual(contents);
    expect(partial.stderr).toContain("install-backups");
  } finally {
    if (server.listening)
      await new Promise<void>((done, reject) => {
        server.close((error) => {
          if (error === undefined) done();
          else reject(error);
        });
      });
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("installer freezes its staged identity and preserves the checkpointed owner when selection changes", async () => {
  const fixture = await installerFixture(),
    { root, state, environment, install } = fixture;
  const frozen = "a".repeat(64),
    changed = "b".repeat(64),
    running = "c".repeat(64);
  const operation = "11111111-2222-4333-8444-555555555555";
  const target: ActivationTarget = {
    target: "local",
    expected_identity: running,
    running_identity: running,
    ready: false,
    process: {
      pid: process.pid,
      start_identity: "retained-start",
      native_id: "retained-owner",
      owner_verified: true,
    },
    sessions: [],
    scheduler_paused: true,
    retirement_policy: "successful-exit",
    stop_accepted: false,
    checkpoint: { state: "confirmed", run_id: operation },
  };
  let stops = 0;
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(SchedulerService, {
          getServerInfo() {
            return { apiVersion: 2 };
          },
          runtimeLifecycle(request) {
            if (request.action === LifecycleAction.STOP) stops++;
            else if (request.action !== LifecycleAction.INVENTORY)
              throw new Error("Unexpected fixture mutation");
            return {
              report: wireLifecycle({ schema_version: 1, targets: [target] }),
            };
          },
        });
      },
    }),
  );
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(join(state, "run.sock"), () => {
        server.off("error", reject);
        done();
      });
    });
    await chmod(join(state, "run.sock"), 0o600);
    const directory = join(root, "operation"),
      identities = join(root, "identities.json"),
      manager = join(root, "manager.txt"),
      mutations = join(root, "manager-mutations.log");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "octo-manager-inventory.json"),
      JSON.stringify({ schema_version: 1, targets: [target] }),
      { mode: 0o600 },
    );
    await writeFile(
      identities,
      JSON.stringify({ identities: [frozen, changed], index: 0 }),
      { mode: 0o600 },
    );
    await writeFile(
      manager,
      process.platform === "darwin"
        ? `state = running\npid = ${String(process.pid)}\n`
        : `LoadState=loaded\nActiveState=active\nMainPID=${String(process.pid)}\n`,
      { mode: 0o600 },
    );
    await writeFile(mutations, "", { mode: 0o600 });
    environment["PROJECT_UPDATE_OPERATION_DIR"] = directory;
    environment["PROJECT_UPDATE_RUN_ID"] = operation;
    environment["OCTO_TEST_ARTIFACT_SEQUENCE"] = identities;
    environment["OCTO_TEST_MANAGER_REPORT"] = manager;
    environment["OCTO_TEST_MANAGER_MUTATIONS"] = mutations;
    const outcome = await install();
    assert.equal(outcome.status, 3, outcome.stderr);
    const receipt: unknown = JSON.parse(outcome.stdout);
    assert(record(receipt));
    expect(receipt["expected_identity"]).toBe(frozen);
    expect(receipt["started"]).toBe(false);
    expect(stops).toBe(0);
    expect(receipt["incomplete_activation"]).toBe(true);
    expect(receipt["reason"]).toBe(
      "native-selected-artifact-identity-changed-before-retirement",
    );
    const observed: unknown = JSON.parse(await readFile(identities, "utf8"));
    assert(record(observed));
    expect(observed["index"]).toBe(2);
    expect(await readFile(mutations, "utf8")).toBe("");
    expect(server.listening).toBe(true);
    expect((await schedulerClient(state).getServerInfo({})).apiVersion).toBe(2);
  } finally {
    if (server.listening)
      await new Promise<void>((done, reject) => {
        server.close((error) => {
          if (error === undefined) done();
          else reject(error);
        });
      });
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
