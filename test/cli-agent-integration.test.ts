import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createApplicationFixture } from "./support/application.js";
import { schedulerClient } from "../src/client.js";
import type { ObservationInput } from "../src/tracking/types.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { Type } from "typebox";
import { Check } from "typebox/value";

const Result = Type.Object(
  {
    pr: Type.Object({ id: Type.String(), url: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const observation: ObservationInput = {
  observedAt: 1000,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  lifecycle: "open",
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
test("real CLI auto-detects agent JSON, retains explicit JSON/full inspection and rejects mutation detail replay", async () => {
  let offline = false;
  const directory = await mkdtemp("/tmp/om-agent-cli-"),
    coordinator = await createApplicationFixture(directory, {
      trackingOptions: {
        read: () =>
          offline ? Promise.reject(new Error("GitHub temporarily unavailable")) : Promise.resolve(observation),
        connect: () => {
          throw new Error("Unexpected delivery");
        },
      },
    });
  async function run(args: string[], agent: boolean) {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--state", directory], {
      env: {
        ...process.env,
        CODEX_THREAD_ID: agent ? "controlled-thread" : "",
        OCTO_MANAGER_AGENT: agent ? "" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output, error, code };
  }
  try {
    await coordinator.start();
    const tracked = await run(["track", "--url", "https://github.com/o/r/pull/1", "--thread-id", "owner"], true);
    expect(tracked.code).toBe(0);
    expect(tracked.error).toBe("");
    expect(tracked.output.trim().split("\n")).toHaveLength(1);
    const value: unknown = JSON.parse(tracked.output);
    if (!Check(Result, value)) throw new Error("Missing agent response");
    expect(value.pr.url).toBe("https://github.com/o/r/pull/1");
    const client = schedulerClient(directory);
    await client.refreshTrackedPullRequest({ id: value.pr.id });
    const compact = await run(["pr", "show", value.pr.id], true);
    expect(compact.code).toBe(0);
    const compactResult: unknown = JSON.parse(compact.output);
    expect(compactResult).not.toHaveProperty("pr.observation.checks");
    expect(compactResult).not.toHaveProperty("data");
    coordinator.githubScheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const full = await run(["pr", "show", value.pr.id, "--full"], true);
    expect(full.code).toBe(0);
    const fullResult: unknown = JSON.parse(full.output);
    expect(fullResult).toHaveProperty("pr.observation.checks");
    expect(fullResult).not.toHaveProperty("ok");
    const explicit = await run(["pr", "show", value.pr.id, "--json"], false);
    expect(explicit.code).toBe(0);
    const explicitResult: unknown = JSON.parse(explicit.output);
    expect(explicitResult).toHaveProperty("pr.observation.checks");
    expect(explicit.output.trim().split("\n")).toHaveLength(1);
    const human = await run(["pr", "show", value.pr.id], false);
    expect(human.code).toBe(0);
    expect(human.output.trim().split("\n").length).toBeGreaterThan(1);
    const humanResult: unknown = JSON.parse(human.output);
    expect(humanResult).not.toHaveProperty("ok");
    const rejected = await run(
      ["track", "--url", "https://github.com/o/r/pull/2", "--thread-id", "owner", "--full"],
      true,
    );
    expect(rejected.code).toBe(1);
    expect(rejected.output).toBe("");
    const rejectedResult: unknown = JSON.parse(rejected.error);
    expect(rejectedResult).toHaveProperty("error.message");
    expect(rejectedResult).not.toHaveProperty("ok");
    expect(Buffer.byteLength(rejected.error)).toBeLessThan(500);
    expect((await client.listTrackedPullRequests({})).prs).toHaveLength(1);
    const failed = await run(["pr", "show", "missing", "--json"], false);
    expect(failed.code).toBe(1);
    expect(failed.output).toBe("");
    const failedResult: unknown = JSON.parse(failed.error);
    expect(failedResult).toHaveProperty("ok", false);
    offline = true;
    const stale = await run(["pr", "refresh", value.pr.id], true);
    expect(stale.code).toBe(0);
    const staleResult: unknown = JSON.parse(stale.output);
    expect(staleResult).toHaveProperty("refresh");
    coordinator.githubScheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const errored = await run(["pr", "show", value.pr.id], true);
    const erroredResult: unknown = JSON.parse(errored.output);
    expect(erroredResult).toMatchObject({
      pr: {
        refreshError: "GitHub temporarily unavailable",
        observation: { observedAtMs: 1000 },
      },
    });
    expect(erroredResult).toHaveProperty("pr.refreshErrorAtMs");
    await client.setPaused({ paused: true });
    const job = coordinator.store.submit({ kind: "resolve_conflict" }, "events-fixture");
    for (let index = 0; index < 30; index++)
      coordinator.store.event(job.id, "fixture_event", `Event ${String(index)} ` + "details ".repeat(100));
    const events = await run(["job", "events", job.id, "--after", "0"], true);
    expect(events.code).toBe(0);
    expect(events.output.trim().split("\n")).toHaveLength(1);
    const page: unknown = JSON.parse(events.output);
    if (!Array.isArray(page)) throw new Error("Invalid event page");
    expect(page.length).toBeGreaterThanOrEqual(30);
    expect(Buffer.byteLength(events.output)).toBeGreaterThan(3000);
    const paused = await run(["pause"], true);
    expect(JSON.parse(paused.output)).toEqual({ scheduler: "paused" });
    const snapshot = {
      repository: "o/r",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      private: false,
      files: [],
      diff: "",
      sources: [],
      sourceDigest: "first-policy",
    };
    coordinator.store.submissions.savePolicy(snapshot, {
      requirements: [],
      template: "",
      blockers: [],
    });
    coordinator.store.submissions.savePolicy(
      { ...snapshot, sourceDigest: "second-policy" },
      {
        requirements: [],
        template: "LATEST POLICY ".repeat(1500),
        blockers: [],
      },
    );
    const template = await run(["history", "policy", "o/r", "--policy-version", "1", "--tier", "routine"], true);
    expect(template.code).toBe(0);
    expect(template.output.trim().split("\n")).toHaveLength(1);
    const policy: unknown = JSON.parse(template.output);
    expect(policy).toHaveProperty("policy.version", 1);
    expect(policy).not.toHaveProperty("template");
    const recovery = await run(
      ["history", "policy", "o/r", "--policy-version", "1", "--tier", "routine", "--full"],
      true,
    );
    expect(recovery.code).toBe(0);
    const recovered: unknown = JSON.parse(recovery.output);
    expect(recovered).toHaveProperty("template", expect.stringContaining("Advisory"));
    const huge = await run(["history", "policy", "o/r", "--policy-version", "2"], true);
    expect(huge.code).toBe(0);
    const hugeResult: unknown = JSON.parse(huge.output);
    expect(hugeResult).not.toHaveProperty("template");
    coordinator.store.tracking.observe(
      value.pr.id,
      { ...observation, mergeability: "conflicting", observedAt: 1001 },
      defaultTrackingConfig(),
    );
    const delivery = coordinator.store.tracking.deliveries()[0];
    if (delivery === undefined) throw new Error("Missing read fixture");
    coordinator.store.tracking.inbox.record(delivery.id, "Conflict notice");
    const read = await run(["read", delivery.id, "--agent-id", delivery.recipientAgentId], true);
    expect(read.code, read.error).toBe(0);
    expect(read.output.trim().split("\n")).toHaveLength(1);
    const readResult: unknown = JSON.parse(read.output);
    expect(readResult).toHaveProperty("evidenceWarning");
    expect(readResult).toHaveProperty("message.items.0.acknowledgedAtMs");
    expect(readResult).toHaveProperty("message.items.0.action.action.conflict.headSha", observation.headSha);
    expect(readResult).not.toHaveProperty("message.recipientAgentId");
    expect(readResult).not.toHaveProperty("message.items.0.action.action.profile");
    expect(readResult).not.toHaveProperty("message.createdAtMs");
    expect(readResult).not.toHaveProperty("data");
    const fullRead = await run(["read", delivery.id, "--agent-id", delivery.recipientAgentId, "--json"], false);
    expect(fullRead.code, fullRead.error).toBe(0);
    const fullReadResult: unknown = JSON.parse(fullRead.output);
    expect(fullReadResult).toHaveProperty("message.recipientAgentId", delivery.recipientAgentId);
    expect(fullReadResult).toHaveProperty("message.items.0.action.action.profile");
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
