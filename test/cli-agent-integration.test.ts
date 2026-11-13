import { join, resolve } from "node:path";
import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import type { ObservationInput } from "../src/tracking/types.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
const Result = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        pr: Type.Object(
          { id: Type.String(), url: Type.String() },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
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
    coordinator = new Coordinator(directory, {
      trackingOptions: {
        read: () =>
          offline
            ? Promise.reject(new Error("GitHub temporarily unavailable"))
            : Promise.resolve(observation),
        connect: () => {
          throw new Error("Unexpected delivery");
        },
      },
    });
  async function run(args: string[], agent: boolean) {
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", ...args, "--state", directory],
      {
        env: {
          ...process.env,
          CODEX_THREAD_ID: agent ? "controlled-thread" : "",
          OCTO_MANAGER_AGENT: agent ? "" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output, error, code };
  }
  try {
    await coordinator.start();
    const tracked = await run(
      [
        "track",
        "--url",
        "https://github.com/o/r/pull/1",
        "--thread-id",
        "owner",
      ],
      true,
    );
    expect(tracked.code).toBe(0);
    expect(tracked.error).toBe("");
    expect(tracked.output.trim().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(tracked.output)).toBeLessThanOrEqual(3001);
    const value: unknown = JSON.parse(tracked.output);
    if (!Check(Result, value)) throw new Error("Missing agent response");
    expect(value.data.pr.url).toBe("https://github.com/o/r/pull/1");
    const client = schedulerClient(directory);
    await client.refreshTrackedPullRequest({ id: value.data.pr.id });
    const compact = await run(["pr", value.data.pr.id], true);
    expect(compact.code).toBe(0);
    expect(compact.output).not.toContain("checksJson");
    expect(compact.output).toContain('"detailsOmitted":true');
    const full = await run(["pr", value.data.pr.id, "--full"], true);
    expect(full.code).toBe(0);
    expect(full.output).toContain("checksJson");
    expect(full.output).not.toContain('"ok":true');
    const explicit = await run(["pr", value.data.pr.id, "--json"], false);
    expect(explicit.code).toBe(0);
    expect(explicit.output).toContain("checksJson");
    expect(explicit.output.trim().split("\n")).toHaveLength(1);
    const human = await run(["pr", value.data.pr.id], false);
    expect(human.code).toBe(0);
    expect(human.output.trim().split("\n").length).toBeGreaterThan(1);
    expect(human.output).not.toContain('"ok"');
    const rejected = await run(
      [
        "track",
        "--url",
        "https://github.com/o/r/pull/2",
        "--thread-id",
        "owner",
        "--full",
      ],
      true,
    );
    expect(rejected.code).toBe(1);
    expect(rejected.output).toBe("");
    expect(rejected.error).toContain('"ok":false');
    expect(Buffer.byteLength(rejected.error)).toBeLessThan(500);
    expect((await client.listTrackedPullRequests({})).prs).toHaveLength(1);
    const failed = await run(["pr", "missing", "--json"], false);
    expect(failed.code).toBe(1);
    expect(failed.output).toBe("");
    expect(failed.error).toContain('"ok":false');
    offline = true;
    const stale = await run(["refresh", value.data.pr.id], true);
    expect(stale.code).toBe(0);
    expect(stale.output).toContain("GitHub temporarily unavailable");
    expect(stale.output).toContain("refreshErrorAtMs");
    expect(stale.output).toContain('"observedAtMs":1000');
    await client.setPaused({ paused: true });
    const job = coordinator.store.submit(
      { kind: "resolve_conflict" },
      "events-fixture",
    );
    for (let index = 0; index < 30; index++)
      coordinator.store.event(
        job.id,
        "fixture_event",
        `Event ${String(index)} ` + "details ".repeat(100),
      );
    const events = await run(["events", job.id, "--after", "0"], true);
    expect(events.code).toBe(0);
    expect(events.output.trim().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(events.output)).toBeLessThanOrEqual(3001);
    const Page = Type.Object(
      { data: Type.Array(Type.Unknown()), omittedItems: Type.Integer() },
      { additionalProperties: true },
    );
    const page: unknown = JSON.parse(events.output);
    if (!Check(Page, page)) throw new Error("Invalid event page");
    expect(page.data.length).toBeLessThanOrEqual(8);
    expect(page.omittedItems).toBeGreaterThan(20);
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
    const template = await run(
      [
        "repo-policy",
        "template",
        "--repo",
        "o/r",
        "--version",
        "1",
        "--tier",
        "routine",
      ],
      true,
    );
    expect(template.code).toBe(0);
    expect(template.output.trim().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(template.output)).toBeLessThanOrEqual(3001);
    const Hint = Type.Object(
      { next: Type.String() },
      { additionalProperties: true },
    );
    const hint: unknown = JSON.parse(template.output);
    if (!Check(Hint, hint)) throw new Error("Missing policy recovery");
    expect(hint.next).toContain("'--version' '1'");
    expect(hint.next).toContain("'--tier' 'routine'");
    const bin = join(directory, "bin");
    await mkdir(bin);
    const shim = join(bin, "octo-manager");
    const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve("src/cli.ts"))} "$@"\n`,
    );
    await chmod(shim, 0o700);
    const recovery = Bun.spawn(["/bin/sh", "-c", hint.next], {
      env: {
        ...process.env,
        PATH: bin + ":" + (process.env["PATH"] ?? ""),
        OCTO_MANAGER_AGENT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [recovered, exit] = await Promise.all([
      new Response(recovery.stdout).text(),
      recovery.exited,
    ]);
    expect(exit).toBe(0);
    expect(recovered).toContain("Advisory");
    expect(recovered).not.toContain("LATEST POLICY");
    const huge = await run(
      ["repo-policy", "template", "--repo", "o/r", "--version", "2"],
      true,
    );
    expect(huge.code).toBe(0);
    expect(Buffer.byteLength(huge.output)).toBeLessThanOrEqual(3001);
    expect(huge.output).not.toContain("LATEST POLICY");
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
