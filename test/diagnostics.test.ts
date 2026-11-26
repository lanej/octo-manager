import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { PerformanceDiagnostics } from "../src/diagnostics/service.js";
import { queryEventsSupported } from "../src/diagnostics/recorder.js";
import { performanceScope, observers } from "../src/diagnostics/scope.js";
import { sqlShape, statementKind } from "../src/diagnostics/sql.js";
import { PerformanceCaptureState as State } from "../src/gen/octomanager/v2/diagnostics_pb.js";
import { createApplicationFixture } from "./support/application.js";
import { schedulerClient } from "../src/client.js";
import { parseCommand } from "../src/cli/arguments.js";

const directory = () => mkdtempSync(join(tmpdir(), "octo-diag-"));
test("expanded SQL redaction removes literals, blobs, comments and quoted identifiers before grouping", () => {
  const result = sqlShape(
    "SELECT 'secret''quote', 123.4e+6, X'534543524554', \"private\" FROM `hidden` WHERE [private] = 'token' /* private comment */ -- secret\n",
  );
  expect(result).toBe(
    "SELECT ?, ?, ?, <quoted> FROM <quoted> WHERE <quoted> = ?",
  );
  expect(sqlShape("SELECT 'unterminated secret")).toBe("SELECT ?");
  expect(sqlShape("SELECT $雪")).toBe("<unrecognized SQL>");
  expect(statementKind("SELECT ?; UPDATE example SET value = ?")).toBe(
    "unknown",
  );
});
test("capture defaults off, validates bounds and rejects unsupported runtimes without creating artifacts", () => {
  const dir = directory();
  try {
    const service = new PerformanceDiagnostics(dir, () => false);
    expect(observers.has(dir)).toBe(false);
    expect(() => service.start("bad", 300001)).toThrow("duration");
    expect(() => service.start("unsupported", 1000)).toThrow(
      "does not publish",
    );
    expect(() => service.get("../escape")).toThrow("Invalid capture ID");
    expect(() => statSync(join(dir, "diagnostics"))).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test.if(queryEventsSupported())(
  "real SQLite events, async scopes, privacy, idempotency, expiry and shutdown survive the disk boundary",
  async () => {
    const dir = directory();
    const service = new PerformanceDiagnostics(dir);
    const db = new DatabaseSync(join(dir, "jobs.sqlite"));
    try {
      expect(queryEventsSupported()).toBe(true);
      db.exec("CREATE TABLE example(value TEXT)");
      const capture = service.start("capture-one", 1000);
      expect(service.start("capture-one", 1000).id).toBe(capture.id);
      expect(() => service.start("capture-one", 2000)).toThrow(
        "different options",
      );
      expect(() => service.start("another", 1000)).toThrow("already active");
      performanceScope(dir, "reader", () => {
        db.prepare("SELECT ? AS value").get("secret-bound-value");
      });
      await performanceScope(dir, "writer", async () => {
        await delay(1);
        db.prepare("INSERT INTO example VALUES (?)").run("secret-bound-value");
      });
      performanceScope(dir, "reader", () => {
        db.prepare("SELECT * FROM example").all();
      });
      await delay(1100);
      const report = service.get(capture.id);
      expect(report.state).toBe(State.COMPLETED);
      expect(observers.has(dir)).toBe(false);
      expect(report.report?.queryEvents).toBeGreaterThanOrEqual(3);
      const reader = report.report?.scopes.find((s) => s.name === "reader");
      expect(reader?.cycles).toBe(2);
      expect(reader?.cyclesWithoutObservedWrites).toBe(2);
      expect(
        report.report?.scopes.find((s) => s.name === "writer")
          ?.cyclesWithoutObservedWrites,
      ).toBe(0);
      const persisted = readFileSync(report.artifactPath, "utf8");
      expect(persisted).not.toContain("secret-bound-value");
      expect(statSync(report.artifactPath).mode & 0o777).toBe(0o600);
      expect(
        new PerformanceDiagnostics(dir).get(report.id).report?.queryEvents,
      ).toBe(report.report?.queryEvents);
      const again = service.start("capture-two", 1000);
      expect(service.stop(again.id).state).toBe(State.STOPPED);
      expect(service.stop(again.id).state).toBe(State.STOPPED);
      const shutdown = service.start("shutdown", 1000);
      service.close();
      expect(service.get(shutdown.id).state).toBe(State.STOPPED);
    } finally {
      service.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("restart does not resume a collecting capture; unsafe reports and terminal write failures remain explicit", () => {
  const dir = directory();
  const service = new PerformanceDiagnostics(dir, () => true);
  try {
    const capture = service.start("interrupted", 1000);
    expect(new PerformanceDiagnostics(dir).get(capture.id).state).toBe(
      State.INTERRUPTED,
    );
    rmSync(capture.artifactPath);
    symlinkSync("/dev/null", capture.artifactPath);
    expect(() => new PerformanceDiagnostics(dir).get(capture.id)).toThrow(
      "valid private",
    );
    rmSync(capture.artifactPath);
    mkdirSync(capture.artifactPath);
    const failed = service.stop(capture.id);
    expect(failed.state).toBe(State.FAILED);
    expect(failed.detail).toContain("write failed");
    expect(observers.has(dir)).toBe(false);
    rmSync(capture.artifactPath, { recursive: true });
    writeFileSync(capture.artifactPath, "{}", { mode: 0o600 });
    expect(() => new PerformanceDiagnostics(dir).get(capture.id)).toThrow(
      "valid private",
    );
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test.if(queryEventsSupported())(
  "bounded groups report overflow and preserve scope isolation",
  () => {
    const dir = directory();
    const other = directory();
    const service = new PerformanceDiagnostics(dir);
    const db = new DatabaseSync(join(dir, "jobs.sqlite"));
    const foreign = new DatabaseSync(join(other, "jobs.sqlite"));
    try {
      const capture = service.start("bounded", 1000);
      performanceScope(other, "foreign", () =>
        foreign.prepare("SELECT 1").get(),
      );
      performanceScope(dir, "bounded", () => {
        for (let n = 0; n < 270; n++)
          db.prepare(`SELECT 1 AS column${String(n)}`).get();
      });
      const report = service.stop(capture.id).report;
      expect(report?.queries.length).toBe(256);
      expect(report?.droppedEvents).toBe(14);
      expect(report?.ignoredDatabaseEvents).toBeGreaterThan(0);
      expect(report?.scopes.some((s) => s.name === "foreign")).toBe(false);
    } finally {
      service.close();
      db.close();
      foreign.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  },
);
test.if(queryEventsSupported())(
  "live typed RPC and actual CLI capture/show/stop work without starting another daemon",
  async () => {
    const dir = directory();
    const coordinator = await createApplicationFixture(dir);
    try {
      await coordinator.start();
      coordinator.command({ op: "pause" });
      const invoke = async (args: string[]) => {
        const child = Bun.spawn(
          [process.execPath, "src/cli.ts", "--state", dir, ...args, "--json"],
          {
            cwd: process.cwd(),
            env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        expect({ exit: await child.exited, stderr }).toEqual({
          exit: 0,
          stderr: "",
        });
        const result: unknown = JSON.parse(stdout);
        if (
          typeof result !== "object" ||
          result === null ||
          !("id" in result) ||
          typeof result.id !== "string" ||
          !("state" in result) ||
          typeof result.state !== "string"
        )
          throw new Error("Invalid CLI response: " + stdout);
        return { id: result.id, state: result.state };
      };
      expect(
        parseCommand(["diagnostics", "show", "abc"], {}).positionals,
      ).toEqual(["diagnostics-show", "abc"]);
      const capture = await invoke([
        "diagnostics",
        "capture",
        "--seconds",
        "1",
        "--request-id",
        "cli",
      ]);
      expect(
        (await schedulerClient(dir).getPerformanceCapture({ id: capture.id }))
          .capture?.state,
      ).toBe(State.COLLECTING);
      expect((await invoke(["diagnostics", "stop", capture.id])).state).toBe(
        "PERFORMANCE_CAPTURE_STATE_STOPPED",
      );
      expect((await invoke(["diagnostics", "show", capture.id])).id).toBe(
        capture.id,
      );
      expect(
        (await invoke(["diagnostics", "capture", "--seconds", "1", "--wait"]))
          .state,
      ).toBe("PERFORMANCE_CAPTURE_STATE_COMPLETED");
    } finally {
      await coordinator.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
