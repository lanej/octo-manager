import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { schedulerClient } from "../src/client.js";
const { values } = parseArgs({
  options: { start: { type: "boolean" } },
  args: process.argv.slice(2),
});
const ResultSchema = Type.Object(
  {
    installed: Type.Literal(true),
    started: Type.Boolean(),
    serviceManager: Type.Union([
      Type.Literal("launchd"),
      Type.Literal("systemd"),
      Type.Literal("manual"),
    ]),
    service: Type.String(),
    servicePath: Type.String(),
    manualCommand: Type.Optional(Type.String()),
    state: Type.String(),
  },
  { additionalProperties: true },
);
type Result = Static<typeof ResultSchema>;
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function command(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
const home = await mkdtemp("/tmp/om-install-"),
  state = join(home, "state"),
  codex = join(home, "codex"),
  config = join(home, "config");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OCTO_MANAGER_STATE: state,
  CODEX_HOME: codex,
  XDG_CONFIG_HOME: config,
};
const start = values.start === true;
if (!start && process.platform === "linux") {
  env["XDG_RUNTIME_DIR"] = join(home, "absent-runtime");
  env["DBUS_SESSION_BUS_ADDRESS"] =
    "unix:path=" + join(home, "absent-user-bus");
}
let foreground: ReturnType<typeof Bun.spawn> | undefined,
  installed: Result | undefined,
  stopped = false,
  startupAttempted = false;
async function install(): Promise<Result> {
  const args = [
    process.execPath,
    "scripts/install-local.ts",
    "--home",
    home,
    "--codex",
    ...(!start && process.platform !== "linux" ? ["--no-start"] : []),
  ];
  const result = await command(args, env);
  assert(result.code === 0, `Installer failed: ${result.stderr}`);
  const value: unknown = JSON.parse(result.stdout.trim());
  assert(Check(ResultSchema, value), "Invalid installer result");
  return value;
}
async function ready(): Promise<void> {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      await schedulerClient(state).getSnapshot({}, { timeoutMs: 500 });
      return;
    } catch {
      await new Promise<void>((done) => {
        setTimeout(done, 100);
      });
    }
  }
  throw new Error("Installed coordinator API did not become ready");
}
try {
  if (!start && process.platform === "linux") {
    const probe = await command(
      ["systemctl", "--user", "show-environment"],
      env,
    );
    assert(
      probe.code !== 0,
      "Unavailable-manager fixture unexpectedly reached a user manager",
    );
  }
  if (start) {
    const preflight =
      process.platform === "linux"
        ? await command(
            ["systemctl", "--user", "cat", "octo-manager.service"],
            env,
          )
        : await command(
            [
              "/bin/launchctl",
              "print",
              `gui/${String(process.getuid?.())}/com.lanej.octo-manager`,
            ],
            env,
          );
    assert(
      preflight.code !== 0,
      "Preserve the existing Octo user service; acceptance requires a disposable user",
    );
  }
  await mkdir(codex, { recursive: true });
  const hooks = join(codex, "hooks.json");
  await writeFile(
    hooks,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo unrelated-fixture" }] },
        ],
      },
    }),
  );
  startupAttempted = start;
  installed = await install();
  if (start && process.platform === "linux")
    assert(
      installed.started,
      "Linux user-manager acceptance did not start a service",
    );
  if (!installed.started) {
    assert(
      installed.manualCommand !== undefined,
      "No runnable manual startup command",
    );
    foreground = Bun.spawn(
      ["/bin/sh", "-c", "exec " + installed.manualCommand],
      { env, stdout: "pipe", stderr: "pipe" },
    );
  }
  await ready();
  const first = await readFile(hooks, "utf8");
  assert(first.includes("echo unrelated-fixture"), "Unrelated hook lost");
  installed = await install();
  await ready();
  assert(
    (await readFile(hooks, "utf8")) === first,
    "Rerun duplicated or changed hook definitions",
  );
  console.log(
    JSON.stringify({
      platform: process.platform,
      serviceManager: installed.serviceManager,
      started: installed.started,
      apiReady: true,
      hooksPreserved: true,
    }),
  );
} finally {
  try {
    if (foreground !== undefined) {
      foreground.kill("SIGTERM");
      const code = await foreground.exited;
      stopped = code === 0 || code === 143;
    } else if (startupAttempted || installed?.started === true) {
      const stop =
        process.platform === "linux"
          ? await command(
              [
                "systemctl",
                "--user",
                "disable",
                "--now",
                "octo-manager.service",
              ],
              env,
            )
          : await command(
              [
                "/bin/launchctl",
                "bootout",
                `gui/${String(process.getuid?.())}/com.lanej.octo-manager`,
              ],
              env,
            );
      stopped = stop.code === 0;
    } else stopped = true;
  } finally {
    if (stopped) await rm(home, { recursive: true, force: true });
    else console.error("Retained installer acceptance fixture: " + home);
  }
}
