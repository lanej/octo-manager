#!/usr/bin/env bun
import { activityCLI } from "./activity/cli.js";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Coordinator } from "./coordinator.js";
import { loadTrackingConfig } from "./tracking/config.js";
import { request, trackingRequest, cliJSON } from "./client.js";
import { existsSync } from "node:fs";
import { terminalStates, type JobEvent } from "./domain.js";

process.umask(0o077);
async function main(): Promise<void> {
  if (await activityCLI(process.argv.slice(2))) return;
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config:{type:"string"}, harness:{type:"string"}, endpoint:{type:"string"}, "thread-id":{type:"string"}, "agent-id":{type:"string"}, label:{type:"string"}, state: { type: "string" }, theme: { type: "string" }, model: { type: "string" }, url: { type: "string" }, "request-id": { type: "string" }, json: { type: "boolean" }, after: { type: "string" }, watch: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  const directory = resolve(values.state ?? process.env.OCTO_MANAGER_STATE ?? join(homedir(), ".local", "state", "octo-manager"));
  const [command, argument] = positionals;
  if (!command || values.help) {
    console.log("octo-manager dashboard | serve | login | demo | submit summarize-pr --url URL | get ID | events ID [--watch] [--after N] | cancel ID | retry ID | pause | resume\nOptions: --state DIR --model MODEL --theme dark|light|contrast|mono --request-id ID --json\nDefault model: openai-codex/gpt-6.1-terra. Agent activity: record-activity --help | activity [--after N]. Tracking: track --url URL --thread-id ID | tracked | pr ID | refresh ID | assign ID --thread-id ID | untrack ID | actions [PR_ID] | action ID | acknowledge ID --agent-id ID | working ID --agent-id ID | retry-delivery ID | reprofile ID | tracking. Tracking accepts private PRs; Pi summary workers remain public-only."); return;
  }
  if (command === "login") {
    console.log("Pi uses a separate ChatGPT login. In Pi, run /login openai-codex, complete the browser flow, then /quit. Credentials are managed by Pi and are never copied from Codex.");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)), "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-session"], { stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); }); return;
  }
  if (command === "dashboard") {
    if (!process.stdin.isTTY) throw new Error("Dashboard needs a terminal");
    const binary = fileURLToPath(new URL("../build/octo-manager-tui", import.meta.url));
    if (!existsSync(binary)) throw new Error("Build the Charmed dashboard first with bun run build");
    const child = spawn(binary, ["--state", directory, "--theme", values.theme ?? "dark"], { stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); });
    return;
  }
  if (command === "serve") {
    const coordinator = new Coordinator(directory, { model: values.model, trackingConfig: loadTrackingConfig(values.config) });
    await coordinator.start();
    console.log(JSON.stringify({ ready: true, state: directory }));
    await new Promise<void>(resolve => { const stop = () => { void coordinator.close().then(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    return;
  }
  const id = argument;
  let result: unknown;
  if (["track","tracked","pr","refresh","assign","untrack","actions","action","acknowledge","working","retry-delivery","reprofile","tracking"].includes(command)) {
    result=await trackingRequest(directory,command,id,{url:values.url,harness:values.harness,endpoint:values.endpoint,sessionId:values["thread-id"],agentId:values["agent-id"],label:values.label});
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
      for (const event of events) { console.log(JSON.stringify(event)); cursor = event.seq; }
      if (!values.watch) break;
      const job = await request(directory, { op: "get", id });
      if (terminalStates.includes(job.status) && events.length < 200) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
    return;
  } else throw new Error("Unsupported command; see --help");
  console.log(JSON.stringify(result, cliJSON, values.json ? undefined : 2));
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
