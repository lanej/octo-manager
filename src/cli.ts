#!/usr/bin/env bun
import { commandTree, CommanderError } from "./command-tree.js";
import { publicationCLI } from "./publication/cli.js";
import {mergingCLI} from "./merging/cli.js";
import {printResult,printFailure} from "./cli-output.js";
import {subscriptionsCLI} from "./tracking/subscriptions-cli.js";
import { notificationsCLI } from "./notifications/cli.js";
import { submissionsCLI } from "./submissions/cli.js";
import { codexHookCLI } from "./integrations/codex.js";
import { repairsCLI } from "./repairs/cli.js";
import { activityCLI } from "./activity/cli.js";
import { directoryLabel, type ParsedCommand } from "./arguments.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { loadTrackingConfig } from "./tracking/config.js";
import { request, trackingRequest } from "./client.js";
import { existsSync } from "node:fs";
import { terminalStates, type JobEvent } from "./domain.js";

process.umask(0o077);
async function execute(parsed: ParsedCommand): Promise<void> {
  switch(parsed.capability){
    case "publication": await publicationCLI(parsed); return;
    case "merging": await mergingCLI(parsed); return;
    case "notifications": await notificationsCLI(parsed); return;
    case "subscriptions": await subscriptionsCLI(parsed); return;
    case "activity": await activityCLI(parsed); return;
    case "repairs": await repairsCLI(parsed); return;
    case "history": await submissionsCLI(parsed); return;
    case "tracking": break;
    case "application": break;
  }
  const { values, positionals } = parsed;
  const directory = resolve(values.state ?? process.env.OCTO_MANAGER_STATE ?? join(homedir(), ".local", "state", "octo-manager"));
  const command = positionals[0]??"", argument=positionals[1];
  if (command === "codex-hook") { await codexHookCLI(directory); return; }
  if (command === "login") {
    console.log("Pi uses a separate ChatGPT login. In Pi, run /login openai-codex, complete the browser flow, then /quit. Credentials are managed by Pi and are never copied from Codex.");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)), "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-session"], { stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); }); return;
  }
  if (command === "dashboard") {
    if (!process.stdin.isTTY) throw new Error("Dashboard needs a terminal");
    const binary = fileURLToPath(new URL("../build/octo-manager-tui", import.meta.url));
    if (!existsSync(binary)) throw new Error("Build the Charmed dashboard first with bun run build");
    const child = spawn(binary, ["--state", directory, "--theme", values.theme ?? "terminal", ...(values.timezone === undefined ? [] : ["--timezone", values.timezone]), ...(values["github-hours"] === undefined ? [] : ["--github-hours", values["github-hours"]])], { stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); });
    return;
  }
  if (command === "serve") {
    const { Coordinator } = await import("./coordinator.js");
    const trackingConfig = loadTrackingConfig(values.config);
    const model = values.model ?? trackingConfig.workerModel;
    const coordinator = new Coordinator(directory, { ...(model === undefined ? {} : { model }), trackingConfig });
    await coordinator.start();
    console.log(JSON.stringify({ ready: true, state: directory }));
    await new Promise<void>(resolve => { const stop = () => { void coordinator.close().then(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    return;
  }
  const id = argument;
  let result: unknown;
  if (["track","tracked","pr","refresh","assign","untrack","actions","action","acknowledge","working","retry-delivery","reprofile","register-agent","agents","tracking","inbox","acknowledge-message"].includes(command)) {
    result = await trackingRequest(directory, command, id, {
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
  } else if (command === "submit" && argument === "summarize-pr" && values.url) result = await request(directory, { op: "submit", requestId: values["request-id"] ?? randomUUID(), task: { kind: "summarize_pr", url: values.url } });
  else if (command === "demo") {
    const requestId = values["request-id"] ?? randomUUID();
    const conflict = await request(directory, { op: "submit", requestId: `${requestId}:conflict`, task: { kind: "resolve_conflict" } });
    const github = await request(directory, { op: "submit", requestId: `${requestId}:github`, task: { kind: "summarize_pr", url: values.url ?? "https://github.com/earendil-works/pi/pull/11546" } });
    result = { conflict, github };
  } else if (["get", "cancel", "retry"].includes(command) && id) result = await request(directory, { op: command, id });
  else if (["pause", "resume"].includes(command)) result = await request(directory, { op: command });
  else if (command === "events" && id) {
    let cursor = Number(values.after ?? 0);
    do {
      const events: JobEvent[] = await request(directory, { op: "events", id, after: cursor });
      if(parsed.output.agent && !parsed.output.full){printResult(parsed,events);return;}
      for (const event of events) { printResult(parsed,event); cursor = event.seq; }
      if (!values.watch) break;
      const job = await request(directory, { op: "get", id });
      if (terminalStates.includes(job.status) && events.length < 200) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
    return;
  } else throw new Error("Unsupported command; see --help");
  printResult(parsed,result);
}
commandTree(process.env,execute).parseAsync(process.argv.slice(2),{from:"user"}).catch((error:unknown)=>{
  if(error instanceof CommanderError && error.exitCode===0)return;
  printFailure(error,process.argv.slice(2),process.env);process.exitCode=1;
});
