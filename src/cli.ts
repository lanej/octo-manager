#!/usr/bin/env bun
import { diagnosticsCLI } from "./diagnostics/cli.js";
import { nativeAot, packageRoot } from "./package-root.js";
import { startupRecord } from "./startup-context.js";
import { requireBun } from "./runtime.js";
import { issuesCLI } from "./issues/cli.js";
import { commandTree, CommanderError } from "./cli/command-tree.js";
import { publicationCLI } from "./publication/cli.js";
import { runtimeLifecycle } from "./lifecycle-rpc.js";
import { artifactIdentity, type ActivationReport } from "./lifecycle.js";
import { readFileSync } from "node:fs";
import { mergingCLI } from "./merging/cli.js";
import { printResult, printFailure } from "./cli/output.js";
import { subscriptionsCLI } from "./tracking/subscriptions-cli.js";
import { notificationsCLI } from "./notifications/cli.js";
import { submissionsCLI } from "./submissions/cli.js";
import { codexHookCLI } from "./integrations/codex.js";
import { repairsCLI } from "./repairs/cli.js";
import { activityCLI } from "./activity/cli.js";
import { directoryLabel, type ParsedCommand } from "./cli/arguments.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { loadTrackingConfig } from "./tracking/config.js";
import { request, trackingRequest } from "./client.js";
import { existsSync } from "node:fs";
import { terminalStates, type JobEvent } from "./jobs/domain.js";

requireBun(process.versions["bun"]);
process.umask(0o077);

async function execute(parsed: ParsedCommand): Promise<void> {
  switch (parsed.capability) {
    case "issues":
      await issuesCLI(parsed);
      return;
    case "publication":
      await publicationCLI(parsed);
      return;
    case "merging":
      await mergingCLI(parsed);
      return;
    case "notifications":
      await notificationsCLI(parsed);
      return;
    case "subscriptions":
      await subscriptionsCLI(parsed);
      return;
    case "diagnostics":
      await diagnosticsCLI(parsed);
      return;
    case "activity":
      await activityCLI(parsed);
      return;
    case "repairs":
      await repairsCLI(parsed);
      return;
    case "history":
      await submissionsCLI(parsed);
      return;
    case "tracking":
      break;
    case "application":
      break;
  }
  const { values, positionals } = parsed;
  const directory = resolve(
    values.state ?? process.env["OCTO_MANAGER_STATE"] ?? join(homedir(), ".local", "state", "octo-manager"),
  );
  const command = positionals[0] ?? "",
    argument = positionals[1];
  if (command === "lifecycle") {
    if (argument === "artifact") {
      console.log(JSON.stringify({ expected_identity: artifactIdentity() }));
      return;
    }
    let restorePaused: boolean | undefined;
    const operation = process.env["PROJECT_UPDATE_OPERATION_DIR"];
    if (argument === "restore" && operation !== undefined) {
      const record: unknown = JSON.parse(readFileSync(join(operation, "octo-manager-inventory.json"), "utf8"));
      if (typeof record === "object" && record !== null && "targets" in record && Array.isArray(record.targets)) {
        const target: unknown = record.targets[0];
        if (
          typeof target === "object" &&
          target !== null &&
          "scheduler_paused" in target &&
          typeof target.scheduler_paused === "boolean"
        )
          restorePaused = target.scheduler_paused;
      }
    }
    let value: ActivationReport;
    try {
      value = await runtimeLifecycle(directory, {
        action: argument ?? "",
        expectedNativeId: process.env["PROJECT_UPDATE_INSTANCE_ID"] ?? "",
        runId: process.env["PROJECT_UPDATE_RUN_ID"] ?? "",
        expectedIdentity: artifactIdentity() ?? "",
        ...(restorePaused === undefined ? {} : { restorePaused }),
      });
    } catch {
      console.log(
        JSON.stringify({
          schema_version: 1,
          targets: [
            {
              target: "local",
              expected_identity: artifactIdentity(),
              running_identity: null,
              ready: false,
              process: null,
              sessions: [],
              reason: "native-lifecycle-control-unavailable",
            },
          ],
        }),
      );
      process.exitCode = 3;
      return;
    }
    console.log(JSON.stringify(value));
    if (argument === "restore" && value.targets[0].reason !== undefined) process.exitCode = 3;
    if (argument === "verify" && !value.targets[0].ready) process.exitCode = 3;
    if (argument === "checkpoint" && value.targets[0].checkpoint?.state !== "confirmed") process.exitCode = 3;
    if (argument === "stop" && !value.targets[0].stop_accepted) process.exitCode = 3;
    return;
  }
  if (command === "codex-hook") {
    await codexHookCLI(directory);
    return;
  }
  if (command === "login") {
    console.log(
      "Pi uses a separate ChatGPT login. In Pi, run /login openai-codex, complete the browser flow, then /quit. Credentials are managed by Pi and are never copied from Codex.",
    );
    const child = spawn(
      nativeAot ? (Bun.which("bun") ?? "bun") : process.execPath,
      [
        join(packageRoot(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-session",
      ],
      { stdio: "inherit" },
    );
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
    return;
  }
  if (command === "dashboard") {
    if (!process.stdin.isTTY) throw new Error("Dashboard needs a terminal");
    const entrypoint = join(packageRoot(), "dist/dashboard/main.js");
    if (!existsSync(entrypoint)) throw new Error("Build the OpenTUI dashboard first with bun run build");
    const bun = nativeAot ? (Bun.which("bun") ?? "bun") : process.execPath;
    const child = spawn(
      bun,
      [
        entrypoint,
        "--state",
        directory,
        "--theme",
        values.theme ?? "terminal",
        ...(values.timezone === undefined ? [] : ["--timezone", values.timezone]),
        ...(values["github-hours"] === undefined ? [] : ["--github-hours", values["github-hours"]]),
      ],
      { stdio: "inherit" },
    );
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
    return;
  }
  if (command === "serve") {
    const { createApplication } = await import("./application/composition.js");
    const trackingConfig = loadTrackingConfig(values.config);
    const model = values.model ?? trackingConfig.workerModel;
    const coordinator = await createApplication(directory, {
      ...(model === undefined ? {} : { model }),
      trackingConfig,
    });
    await coordinator.start();
    console.log(JSON.stringify(startupRecord(directory)));
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        void coordinator.close().then(resolve, reject);
      };
      coordinator.onRetired(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const id = argument;
  let result: unknown;
  if (
    [
      "track",
      "tracked",
      "pr",
      "refresh",
      "assign",
      "untrack",
      "actions",
      "action",
      "assessment",
      "retry-assessment",
      "acknowledge",
      "working",
      "retry-delivery",
      "reprofile",
      "register-agent",
      "agents",
      "tracking",
      "inbox",
      "acknowledge-message",
    ].includes(command)
  ) {
    result = await trackingRequest(directory, command, id, {
      full: parsed.output.full,
      cwd: values.cwd ?? process.cwd(),
      ...(values.url === undefined ? {} : { url: values.url }),
      ...(values.harness === undefined ? {} : { harness: values.harness }),
      ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
      ...(values["thread-id"] === undefined ? {} : { sessionId: values["thread-id"] }),
      ...(values["agent-id"] === undefined ? {} : { agentId: values["agent-id"] }),
      ...(values.after === undefined ? {} : { after: values.after }),
      ...(values["applicable-only"] === undefined ? {} : { applicableOnly: values["applicable-only"] }),
      ...(values["include-acknowledged"] === undefined ? {} : { includeAcknowledged: values["include-acknowledged"] }),
      label: values.label ?? directoryLabel(values.cwd ?? process.cwd()),
    });
  } else if (command === "submit" && argument === "summarize-pr" && values.url !== undefined && values.url !== "")
    result = await request(directory, {
      op: "submit",
      requestId: values["request-id"] ?? randomUUID(),
      task: { kind: "summarize_pr", url: values.url },
    });
  else if (command === "demo") {
    const requestId = values["request-id"] ?? randomUUID();
    const conflict = await request(directory, {
      op: "submit",
      requestId: `${requestId}:conflict`,
      task: { kind: "resolve_conflict" },
    });
    const github = await request(directory, {
      op: "submit",
      requestId: `${requestId}:github`,
      task: { kind: "summarize_pr", url: values.url ?? "https://github.com/earendil-works/pi/pull/11546" },
    });
    result = { conflict, github };
  } else if ((command === "get" || command === "cancel" || command === "retry") && id !== undefined && id !== "")
    result = await request(directory, { op: command, id });
  else if (command === "pause" || command === "resume") result = await request(directory, { op: command });
  else if (command === "events" && id !== undefined && id !== "") {
    let cursor = Number(values.after ?? 0);
    for (;;) {
      const events: JobEvent[] = await request(directory, { op: "events", id, after: cursor });
      if (parsed.output.agent && !parsed.output.full) {
        printResult(parsed, events);
        return;
      }
      for (const event of events) {
        printResult(parsed, event);
        cursor = event.seq;
      }
      if (values.watch !== true) break;
      const job = await request(directory, { op: "get", id });
      if (terminalStates.includes(job.status) && events.length < 200) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return;
  } else throw new Error("Unsupported command; see --help");
  printResult(parsed, result);
}

commandTree(process.env, execute)
  .parseAsync(process.argv.slice(2), { from: "user" })
  .catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    printFailure(error, process.argv.slice(2), process.env);
    process.exitCode = 1;
  });
