import { wireLifecycle } from "../src/lifecycle-rpc.js";
import { LifecycleAction } from "../src/gen/octomanager/v2/lifecycle_pb.js";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { renameSync } from "node:fs";
import { createServer } from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SchedulerService } from "../src/gen/octomanager/v2/scheduler_pb.js";
import { test, expect } from "bun:test";
import {
  serviceDefinition,
  startService,
  managerAvailable,
  type ServiceInput,
} from "../src/install/service.js";
const input: ServiceInput = {
  home: "/fixture/home",
  release: "/fixture/release",
  state: "/fixture/state",
  path: "/usr/bin",
  configHome: "/fixture/config",
  codexHome: "/fixture/codex",
};
const image = "a".repeat(64);
async function nativeFixture<T>(
  action: (selected: ServiceInput, launch: () => void) => Promise<T>,
): Promise<T> {
  const state = await mkdtemp("/tmp/octo-service-proof-");
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(SchedulerService, {
          getServerInfo() {
            return { apiVersion: 2 };
          },
          runtimeLifecycle(request) {
            if (request.action !== LifecycleAction.INVENTORY)
              throw new Error("start proof attempted mutation");
            return {
              report: wireLifecycle({
                schema_version: 1,
                targets: [
                  {
                    target: "local",
                    expected_identity: image,
                    running_identity: image,
                    ready: true,
                    process: {
                      pid: process.pid,
                      start_identity: "fixture-start",
                      native_id: "fixture-owner",
                      owner_verified: true,
                    },
                    sessions: [],
                    scheduler_paused: false,
                    retirement_policy: "successful-exit",
                    stop_accepted: false,
                  },
                ],
              }),
            };
          },
        });
      },
    }),
  );
  const prepared = join(state, "prepared.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(prepared, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(prepared, 0o600);
  try {
    return await action({ ...input, state }, () => {
      renameSync(prepared, join(state, "run.sock"));
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await rm(state, { recursive: true, force: true });
  }
}
test("Linux service activation starts a stopped installed unit and verifies the exact native owner", async () => {
  await nativeFixture(async (selected, launch) => {
    const definition = serviceDefinition("linux", selected, 1000),
      calls: string[][] = [];
    let started = false;
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "/usr/bin/env")
        return JSON.stringify({ expected_identity: image });
      if (args[1] === "start") {
        launch();
        started = true;
      }
      return args[1] === "show"
        ? started
          ? `LoadState=loaded\nActiveState=active\nMainPID=${String(process.pid)}\n`
          : "LoadState=loaded\nActiveState=inactive\nMainPID=0\n"
        : "";
    };
    expect(definition.text).toContain("WorkingDirectory=/fixture/release\n");
    expect(definition.text).toContain(
      'ExecStart="/usr/bin/env" "bun" "/fixture/release/dist/cli.js" "serve"',
    );
    expect(definition.text).toContain(
      'Environment="CODEX_HOME=/fixture/codex"',
    );
    const manual = await startService(
      definition,
      selected,
      false,
      run,
      false,
      image,
    );
    expect(manual.started).toBe(false);
    expect(manual.serviceManager).toBe("manual");
    expect(manual.manualCommand).toContain("serve");
    expect(calls).toHaveLength(0);
    const noStart = await startService(
      definition,
      selected,
      true,
      run,
      true,
      image,
    );
    expect(noStart.started).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      (await startService(definition, selected, false, run, true, image))
        .started,
    ).toBe(true);
    expect(
      calls.filter((args) => args[0] === "systemctl").map((args) => args[2]),
    ).toEqual([
      "show",
      "daemon-reload",
      "enable",
      "start",
      "is-active",
      "show",
      "show",
    ]);
    let failed = false;
    try {
      await startService(
        definition,
        selected,
        false,
        () => {
          throw new Error("Invalid unit");
        },
        true,
        image,
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
});
test("service escaping preserves literal environment values and quoted executable paths", () => {
  const definition = serviceDefinition(
    "linux",
    { ...input, path: '/fixture/space $HOME%"/bin', home: '/fixture/$HOME%"' },
    1000,
  );
  expect(definition.text).toContain('space $HOME%%\\"/bin');
  expect(definition.text).toContain('Environment="HOME=/fixture/$HOME%%\\""');
  expect(() =>
    serviceDefinition("linux", { ...input, state: "bad\nvalue" }, 1000),
  ).toThrow();
});
test("launchd starts only an authoritatively absent service and confirms the exact native image", async () => {
  await nativeFixture(async (selected, launch) => {
    const definition = serviceDefinition("darwin", selected, 501),
      calls: string[][] = [];
    let started = false;
    const result = await startService(
      definition,
      selected,
      false,
      (command, args) => {
        calls.push([command, ...args]);
        if (command === "/usr/bin/env")
          return JSON.stringify({ expected_identity: image });
        if (args[0] === "print" && !started)
          throw Object.assign(new Error("owned fixture job absent"), {
            status: 113,
          });
        if (args[0] === "kickstart") {
          launch();
          started = true;
        }
        return `state = running\npid = ${String(process.pid)}\n`;
      },
      true,
      image,
    );
    expect(result.started).toBe(true);
    expect(
      calls
        .filter((args) => args[0] === "/bin/launchctl")
        .map((args) => args[1]),
    ).toEqual([
      "print",
      "bootstrap",
      "enable",
      "kickstart",
      "print",
      "print",
      "print",
    ]);
    expect(definition.text).toContain("/fixture/release/dist/cli.js");
  });
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
      home: "/alternate/home with '$'",
      configHome: "/alternate/config $value",
      codexHome: "/alternate/codex'home",
      path: directory + ":/alternate/bin",
    };
    const result = await startService(
      serviceDefinition("linux", alternate, 1000),
      alternate,
      false,
      () => "",
      false,
      image,
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
