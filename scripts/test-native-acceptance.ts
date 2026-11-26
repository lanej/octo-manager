import { PerformanceCaptureState } from "../src/gen/octomanager/v2/diagnostics_pb.js";
import { buildNative } from "./build-native.js";
import { mkdtemp, mkdir, cp, copyFile, writeFile, rm, access } from "node:fs/promises";
import { fork } from "node:child_process";
import { join, resolve } from "node:path";
import { schedulerClient } from "../src/client.js";
import { runtimeLifecycle } from "../src/lifecycle-rpc.js";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
const temporary = await mkdtemp("/tmp/octo-native-acceptance-");
const release = join(temporary, "releases", "native"),
  state = join(temporary, "state"),
  home = join(temporary, "home");
const env = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: home,
  CODEX_HOME: join(home, "codex"),
  PI_CODING_AGENT_DIR: join(home, "pi"),
  PROJECT_UPDATE_RETIREMENT_POLICY: "successful-exit",
};
let daemon: ReturnType<typeof Bun.spawn> | undefined;
try {
  const compiler = process.env["OCTO_AOT_BUN"];
  if (compiler === undefined || compiler === "")
    throw new Error("Set OCTO_AOT_BUN to verify native supported-provider initialization");
  const providerProbe = join(temporary, "provider-probe");
  buildNative(compiler, providerProbe, "scripts/native-provider-probe.ts");
  const syntheticCodex = join(home, "codex");
  await mkdir(syntheticCodex, { recursive: true });
  const claims = Buffer.from(
    JSON.stringify({
      exp: 4102444800,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "synthetic-account",
      },
    }),
  ).toString("base64url");
  await writeFile(
    join(syntheticCodex, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: `synthetic.${claims}.synthetic` },
    }),
    { mode: 0o600 },
  );
  const supportedProviders = [];
  for (const providerId of ["openai-codex", "amazon-bedrock"]) {
    const provider = Bun.spawnSync([providerProbe, home, providerId], {
      cwd: temporary,
      env:
        providerId === "amazon-bedrock"
          ? {
              ...env,
              AWS_REGION: "us-east-1",
              AWS_ACCESS_KEY_ID: "synthetic",
              AWS_SECRET_ACCESS_KEY: "synthetic",
              AWS_EC2_METADATA_DISABLED: "true",
            }
          : env,
    });
    assert(provider.exitCode === 0, provider.stderr.toString());
    const providerResult: unknown = JSON.parse(provider.stdout.toString());
    assert(
      typeof providerResult === "object" &&
        providerResult !== null &&
        "provider" in providerResult &&
        providerResult.provider === providerId &&
        "authResolved" in providerResult &&
        providerResult.authResolved === true &&
        "providerInitialized" in providerResult &&
        providerResult.providerInitialized === true &&
        "networkAttempts" in providerResult &&
        providerResult.networkAttempts === 0 &&
        "sdkSendAttempts" in providerResult &&
        providerResult.sdkSendAttempts === 0,
      "Native provider initialization evidence missing",
    );
    supportedProviders.push(providerResult);
  }
  await rm(syntheticCodex, { recursive: true });
  await mkdir(join(release, "build"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const name of ["dist", "node_modules"])
    await cp(resolve(name), join(release, name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  for (const name of ["package.json", "bun.lock", "build/octo-manager"])
    await copyFile(resolve(name), join(release, name));
  const revision = "a".repeat(40);
  await writeFile(join(release, "release.json"), JSON.stringify({ revision, format: "native-aot" }));
  const binary = join(release, "build/octo-manager");
  const artifact = Bun.spawnSync([binary, "lifecycle", "artifact"], {
    cwd: home,
    env,
  });
  assert(artifact.exitCode === 0, artifact.stderr.toString());
  const identity: unknown = JSON.parse(artifact.stdout.toString());
  assert(
    typeof identity === "object" &&
      identity !== null &&
      "expected_identity" in identity &&
      typeof identity.expected_identity === "string" &&
      /^[a-f0-9]{64}$/u.test(identity.expected_identity),
    "Missing physical artifact identity",
  );
  daemon = Bun.spawn([binary, "serve", "--state", state], {
    cwd: home,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = schedulerClient(state);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.getSnapshot({}, { timeoutMs: 100 });
      ready = true;
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert(ready, "Relocated native server did not become ready");
  const captureRequestId = "native-acceptance-capture";
  await client.startPerformanceCapture({
    requestId: captureRequestId,
    durationMs: 1000,
  });
  const captureCommand = Bun.spawn(
    [
      binary,
      "--state",
      state,
      "diagnostics",
      "capture",
      "--seconds",
      "1",
      "--request-id",
      captureRequestId,
      "--wait",
      "--json",
    ],
    { cwd: home, env, stdout: "pipe", stderr: "pipe" },
  );
  // Idle jobs have no periodic tick; a real API mutation supplies observable scheduled work.
  await client.setPaused({ paused: true });
  await client.setPaused({ paused: false });
  const captureOutput = await new Response(captureCommand.stdout).text();
  const captureErrors = await new Response(captureCommand.stderr).text();
  assert((await captureCommand.exited) === 0, "Native diagnostics capture failed: " + captureErrors);
  const captureResult: unknown = JSON.parse(captureOutput);
  assert(
    typeof captureResult === "object" &&
      captureResult !== null &&
      "id" in captureResult &&
      typeof captureResult.id === "string",
    "Native capture did not return an identity",
  );
  const captured = (await client.getPerformanceCapture({ id: captureResult.id })).capture;
  assert(
    captured?.state === PerformanceCaptureState.COMPLETED &&
      (captured.report?.queryEvents ?? 0) > 0 &&
      captured.report?.scopes.some((scope) => scope.name === "jobs" && scope.cycles > 0) === true,
    "Native capture did not retain completed query and scheduler work",
  );
  const report = await runtimeLifecycle(state, {
    action: "inventory",
    expectedNativeId: "",
    runId: "",
    expectedIdentity: "",
  });
  assert(
    report.targets[0].running_identity === identity.expected_identity && report.targets[0].ready,
    "Native running and selected identity differ",
  );
  for (const kind of ["job", "assessment"]) {
    const child = fork(`--octo-internal-worker=${kind}`, [], {
      execPath: binary,
      execArgv: [],
      cwd: home,
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let failure = false;
    let diagnostic = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((fulfilled, rejected) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          rejected(new Error(`Native ${kind} IPC timeout: ${diagnostic}`));
        }, 10000);
        child.once("error", rejected);
        child.once("exit", () => {
          if (failure) fulfilled();
          else rejected(new Error(`Native ${kind} exited before rejection: ${diagnostic}`));
        });
        child.on("message", (message: unknown) => {
          if (typeof message === "object" && message !== null && "type" in message && message.type === "failure") {
            failure = true;
            child.kill("SIGTERM");
          }
        });
        child.send(
          kind === "job"
            ? {
                type: "start",
                attempt: 1,
                task: {
                  kind: "summarize_pr",
                  url: "https://github.com/example/repo/pull/1",
                },
                model: "unsupported/model",
              }
            : {},
          (error) => {
            if (error !== null) rejected(error);
          },
        );
      });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((done) => {
          child.once("exit", () => {
            done();
          });
        });
      }
    }
  }
  const publicationState = join(temporary, "publication-state");
  const publication = Bun.spawnSync(
    [binary, "--octo-internal-worker=publication", publicationState, "missing-native-test"],
    { cwd: home, env },
  );
  assert(
    publication.exitCode !== 0 && publication.stderr.toString().includes("not found"),
    "Native publication worker did not reject missing receipt",
  );
  await access(join(publicationState, "publications", "requests.sqlite"));
  console.log(
    JSON.stringify({
      native: true,
      relocated: true,
      ready,
      physicalIdentity: identity.expected_identity,
      workerIPC: ["job", "assessment"],
      publicationWorker: "missing-receipt-rejected",
      supportedProviders,
      externalEffects: false,
    }),
  );
} finally {
  if (daemon !== undefined) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
