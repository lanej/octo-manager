import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
for (const fixture of [
  "held",
  "lost",
  "publishing",
  "enrolling",
  "uncertain",
]) {
  test(`native checkpoint preserves ${fixture} delivery or publication authority without replay`, async () => {
    const directory = await mkdtemp("/tmp/octo-effects-v2-"),
      release = join(directory, "releases", "current"),
      state = join(directory, "state");
    await mkdir(join(release, "dist"), { recursive: true, mode: 0o700 });
    await mkdir(join(release, "node_modules"), { mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    const source = resolve("src"),
      entry = join(directory, "probe.ts"),
      statusPath = join(directory, "status.json");
    await writeFile(
      entry,
      `
import { Coordinator } from ${JSON.stringify(join(source, "coordinator.ts"))};
import { defaultTrackingConfig } from ${JSON.stringify(join(source, "tracking/config.ts"))};
import { DeliveryError } from ${JSON.stringify(join(source, "agents/codex.ts"))};
import { SubmissionState, Complexity } from ${JSON.stringify(join(source, "submissions/contracts.ts"))};
import { writeFileSync } from "node:fs";
const fixture=${JSON.stringify(fixture)}, statusPath=${JSON.stringify(statusPath)}, state=${JSON.stringify(state)};
let sends=0, closes=0, rejectHeld;
const observation={observedAt:1000,headSha:"a".repeat(40),baseSha:"b".repeat(40),lifecycle:"open",mergeability:"conflicting",checks:{state:"complete",value:[]},reviews:{state:"complete",value:[]}};
const config=defaultTrackingConfig(); config.endpoints.local={delivery:"turn"};
const coordinator=new Coordinator(state,{now:()=>1000,trackingConfig:config,notificationReader:{identity:async()=>"fixture",page:async()=>({updates:[],more:false,notModified:true,pollSeconds:60000})},trackingOptions:{read:async()=>observation,connect:()=>({prepare:async()=>({busy:false,version:"fixture"}),find:async()=>({found:false}),send:async()=>{sends++;if(fixture==="lost")throw new DeliveryError("Fixture accepted remote request; ACK lost",true);return new Promise((_,reject)=>{rejectHeld=reject;});},close:()=>{closes++;rejectHeld?.(new DeliveryError("Fixture close while ACK held",true));}})},mergeOptions:{provider:{inspect:async()=>{throw new Error("No external inspection");},merge:async()=>{throw new Error("No external mutation");}}}});
let submission;
if(fixture==="held"||fixture==="lost") { const pr=coordinator.store.tracking.track("https://github.com/example/example/pull/1",{harness:"codex",endpoint:"local",sessionId:"fixture"});coordinator.store.tracking.observe(pr.id,observation,config); }
else { const request={requestId:"fixture",repository:"example/example",headRef:"fixture",headSha:"a".repeat(40),baseRef:"main",purpose:"Retained publication",validation:[],draft:false,owner:{harness:"codex",endpoint:"local",sessionId:"fixture"}};const value=coordinator.store.submissions.request(request);submission=value.id;coordinator.store.submissions.save({...value,state:fixture,brief:{schemaVersion:1,request,baseSha:"b".repeat(40),policyVersion:1,change:{tier:Complexity.Routine,rationale:"Retained",outcome:"Retained",claims:[],limitations:[],blockers:[]},draft:{title:"fix: retained",body:"Retained",requirementChecks:[],blockers:[]}}});coordinator.store.submissions.deferReconciliation(value.id,0,Number.MAX_SAFE_INTEGER); }
await coordinator.start();
const timer=setInterval(()=>writeFileSync(statusPath,JSON.stringify({sends,closes,pid:process.pid,delivery:coordinator.store.tracking.deliveries()[0]?.progress.state,submission:submission===undefined?undefined:coordinator.store.submissions.get(submission).state,tracker:coordinator.tracking.checkpointable(),other:[coordinator.assessments.checkpointable(),coordinator.issues.checkpointable(),coordinator.merging.checkpointable(),coordinator.repairs.checkpointable(),coordinator.digests.checkpointable(),coordinator.notifications.checkpointable()],publication:coordinator.submissions.checkpointable()})),10);
let stopping=false;const close=()=>{if(stopping)return;stopping=true;clearInterval(timer);coordinator.close().then(()=>process.exit(0),()=>process.exit(1));};process.on("SIGTERM",close);process.on("SIGINT",close);coordinator.once("retired",close);
`,
      { mode: 0o600 },
    );
    for (const selected of [resolve("src/cli.ts"), entry]) {
      const result = await Bun.build({
        entrypoints: [selected],
        target: "bun",
        outdir: join(release, "dist"),
      });
      expect(result.success).toBe(true);
    }
    for (const name of ["package.json", "bun.lock"])
      await copyFile(resolve(name), join(release, name));
    const environment = {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      CODEX_HOME: join(directory, "codex"),
      OCTO_MANAGER_STATE: state,
      PROJECT_UPDATE_RETIREMENT_POLICY: "successful-exit",
      PROJECT_UPDATE_RUN_ID: randomUUID(),
    };
    const child = Bun.spawn(
      [process.execPath, join(release, "dist", "probe.js")],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    );
    const cli = async (action: string, nativeId = "") => {
      const invocation = Bun.spawn(
        [
          process.execPath,
          join(release, "dist", "cli.js"),
          "lifecycle",
          action,
        ],
        {
          env: { ...environment, PROJECT_UPDATE_INSTANCE_ID: nativeId },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const value: unknown = JSON.parse(
        await new Response(invocation.stdout).text(),
      );
      return { code: await invocation.exited, value };
    };
    try {
      const deadline = Date.now() + 5000;
      let before: Record<string, unknown> | undefined;
      for (;;) {
        try {
          const value: unknown = JSON.parse(await readFile(statusPath, "utf8"));
          if (
            record(value) &&
            Array.isArray(value["other"]) &&
            value["other"].every((item) => item === true) &&
            ((fixture === "held" && value["delivery"] === "sending") ||
              (fixture === "lost" && value["delivery"] === "uncertain") ||
              value["submission"] === fixture)
          ) {
            before = value;
            break;
          }
        } catch {
          // The owned coordinator publishes the first status file after startup.
        }
        if (Date.now() > deadline)
          throw new Error("Fixture effects did not settle");
        await Bun.sleep(20);
      }
      const inventory = await cli("inventory");
      assert(record(inventory.value));
      const targets = inventory.value["targets"];
      assert(Array.isArray(targets));
      const target: unknown = targets[0];
      assert(record(target));
      const owner = target["process"];
      assert(record(owner));
      assert.equal(owner["pid"], child.pid);
      const nativeId = owner["native_id"];
      assert.equal(typeof nativeId, "string");
      if (typeof nativeId !== "string")
        throw new Error("Native incarnation unavailable");
      for (let iteration = 0; iteration < 3; iteration++) {
        expect((await cli("checkpoint", nativeId)).code).toBe(3);
        expect((await cli("verify")).code).toBe(0);
      }
      const after: unknown = JSON.parse(await readFile(statusPath, "utf8"));
      assert(record(after));
      expect(after["pid"]).toBe(child.pid);
      expect(child.exitCode).toBeNull();
      expect(after["sends"]).toBe(before["sends"]);
      expect(after["closes"]).toBe(before["closes"]);
      if (fixture === "held" || fixture === "lost") {
        expect(after["sends"]).toBe(1);
        expect(after["delivery"]).toBe(
          fixture === "held" ? "sending" : "uncertain",
        );
      } else expect(after["submission"]).toBe(fixture);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}
