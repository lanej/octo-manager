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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("installer preserves legacy consumers and reports partial promotion after an acknowledged current change", async () => {
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
                      contents: (await readFile(args.path, "utf8")).replace(
                        "  return execFileSync(command, args, {",
                        '  if (command === "/bin/launchctl") throw Object.assign(new Error("No fixture manager"), {status: 113});\n  return execFileSync(command, args, {',
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
    `#!${runtime}\nimport { cpSync, mkdirSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log(process.versions.bun);}\nelse if(args[0]==='run'&&args[1]==='build'){}\nelse if(args[0]==='node_modules/typescript/bin/tsc'){cpSync(join(process.cwd(),'fixture-dist'),args[2],{recursive:true});}\nelse if(args[0]==='install'){mkdirSync(join(process.cwd(),'node_modules'));}\nelse {const child=Bun.spawn([${JSON.stringify(runtime)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;}\n`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(bin, "systemctl"),
    "#!/bin/sh\nprintf '%s\\n' 'LoadState=not-found' 'ActiveState=inactive' 'MainPID=0'\n",
    { mode: 0o755 },
  );
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
  async function install(flag: string) {
    const child = Bun.spawn(
      [
        runtime,
        join(source, "scripts/install-local.js"),
        "--home",
        home,
        "--codex",
        flag,
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text(),
      stderr = await new Response(child.stderr).text();
    return { status: await child.exited, stdout, stderr };
  }
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
