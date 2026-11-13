import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "bun:test";
import {
  serviceDefinition,
  startService,
  managerAvailable,
  type ServiceInput,
} from "../src/install/service.js";
const input: ServiceInput = {
  home: "/fixture/home",
  bun: "/fixture/bun",
  release: "/fixture/release",
  state: "/fixture/state",
  path: "/usr/bin",
  configHome: "/fixture/config",
  codexHome: "/fixture/codex",
};
test("Linux service activation is explicit, native and reports unavailable-manager manual startup", async () => {
  const definition = serviceDefinition("linux", input, 1000),
    calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return "";
  };
  expect(definition.text).toContain("WorkingDirectory=/fixture/release\n");
  expect(definition.text).toContain(
    'ExecStart="/fixture/bun" "/fixture/release/dist/cli.js" "serve"',
  );
  expect(definition.text).toContain('Environment="CODEX_HOME=/fixture/codex"');
  const manual = await startService(definition, input, false, run, false);
  expect(manual.started).toBe(false);
  expect(manual.serviceManager).toBe("manual");
  expect(manual.manualCommand).toContain("serve");
  expect(calls).toHaveLength(0);
  const noStart = await startService(definition, input, true, run, true);
  expect(noStart.started).toBe(false);
  expect(calls).toHaveLength(0);
  expect(
    (await startService(definition, input, false, run, true)).started,
  ).toBe(true);
  expect(calls.map((args) => args[2])).toEqual([
    "daemon-reload",
    "enable",
    "restart",
    "is-active",
  ]);
  let failed = false;
  try {
    await startService(
      definition,
      input,
      false,
      () => {
        throw new Error("Invalid unit");
      },
      true,
    );
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(
    managerAvailable(definition, () => {
      throw Object.assign(new Error("No bus"), { status: 1 });
    }),
  ).toBe(false);
});
test("service escaping preserves literal environment values and quoted executable paths", () => {
  const definition = serviceDefinition(
    "linux",
    { ...input, bun: '/fixture/space $HOME%"/bun', home: '/fixture/$HOME%"' },
    1000,
  );
  expect(definition.text).toContain('space $$HOME%%\\"/bun');
  expect(definition.text).toContain('Environment="HOME=/fixture/$HOME%%\\""');
  expect(() =>
    serviceDefinition("linux", { ...input, state: "bad\nvalue" }, 1000),
  ).toThrow();
});
test("launchd keeps owned service replacement and confirms the running state", async () => {
  const definition = serviceDefinition("darwin", input, 501),
    calls: string[][] = [];
  const result = await startService(
    definition,
    input,
    false,
    (_command, args) => {
      calls.push(args);
      return "state = running";
    },
    true,
  );
  expect(result.started).toBe(true);
  expect(calls.map((args) => args[0])).toEqual([
    "print",
    "bootout",
    "bootstrap",
    "enable",
    "kickstart",
    "print",
  ]);
  expect(definition.text).toContain("/fixture/release/dist/cli.js");
});

test("manual startup preserves the exact alternate installation environment", async () => {
  const directory = await mkdtemp("/tmp/om-env-");
  try {
    const executable = join(directory, "bun");
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(JSON.stringify({home:process.env["HOME"],config:process.env["XDG_CONFIG_HOME"],codex:process.env["CODEX_HOME"],state:process.env["OCTO_MANAGER_STATE"],path:process.env["PATH"]}));\n`,
    );
    await chmod(executable, 0o755);
    const alternate = {
      ...input,
      bun: executable,
      home: "/alternate/home with '$'",
      configHome: "/alternate/config $value",
      codexHome: "/alternate/codex'home",
      path: "/alternate/bin",
    };
    const result = await startService(
      serviceDefinition("linux", alternate, 1000),
      alternate,
      false,
      () => "",
      false,
    );
    if (result.manualCommand === undefined)
      throw new Error("No manual command");
    const child = Bun.spawn(["/bin/sh", "-c", result.manualCommand], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output) as unknown).toEqual({
      home: alternate.home,
      config: alternate.configHome,
      codex: alternate.codexHome,
      state: alternate.state,
      path: alternate.path,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
