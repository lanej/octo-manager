import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  PerformanceReportSchema,
  PerformanceQuerySchema,
  PerformanceScopeSchema,
  type PerformanceQuery,
  type PerformanceScope,
} from "../gen/octomanager/v2/diagnostics_pb.js";
import { sqlShape, statementKind } from "./sql.js";
import { context, observers, type Cycle, type ScopeObserver } from "./scope.js";

const channel = "sqlite.db.query";
export function queryEventsSupported(): boolean {
  let seen = false;
  const observe = () => {
    seen = true;
  };
  const db = new DatabaseSync(":memory:");
  subscribe(channel, observe);
  try {
    db.prepare("SELECT 1").get();
  } finally {
    unsubscribe(channel, observe);
    db.close();
  }
  return seen;
}
interface QueryEvent {
  sql: string;
  duration: number | bigint;
  database: { location(): string | null };
}
function isQueryEvent(event: unknown): event is QueryEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Partial<QueryEvent>;
  return (
    typeof e.sql === "string" &&
    (typeof e.duration === "number" || typeof e.duration === "bigint") &&
    typeof e.database?.location === "function"
  );
}

export class Recorder implements ScopeObserver {
  readonly report = create(PerformanceReportSchema, {
    limits: [
      "Completed statement events include nested SQLite helpers; totals are not exclusive CPU or application call counts.",
      "Runtime durations may be zero at timer precision; wall times and observer callback elapsed time are not CPU measurements.",
      "Literals, comments and quoted identifiers are redacted before hashing or storage; shapes can combine distinct queries.",
      "First and every 100th event per shape/scope samples a stack, at most 4 distinct stacks of 2048 characters; no error messages retained.",
      "Bounds: 256 query groups, 32 scopes, 65536 input characters, 2048 shape characters, 1 MiB retained strings; overflow counted.",
      "Cycles without observed writes exclude ambiguous statements but cannot establish absence of external writes or actual row changes.",
      "Cycles spanning capture boundaries are partial; detached work retains scope attribution but is excluded from closed-cycle write accounting.",
    ],
  });
  private groups = new Map<string, PerformanceQuery>();
  private scopes = new Map<string, PerformanceScope>();
  private locations = new WeakMap<object, boolean>();
  private retained = 0;
  private started = performance.now();
  private closed = false;
  private database: string;
  constructor(private directory: string) {
    directory = resolve(directory);
    this.directory = directory;
    this.database = resolve(realpathSync(directory), "jobs.sqlite");
    if (observers.has(directory)) throw new Error("Capture already active for this directory");
    observers.set(directory, this);
    subscribe(channel, this.receive);
  }
  cycle(name: string): Cycle | undefined {
    if (this.closed) return undefined;
    if (!this.scopes.has(name)) {
      if (this.scopes.size >= 32 || name.length > 80) {
        this.report.droppedScopes++;
        return undefined;
      }
      const scope = create(PerformanceScopeSchema, { name });
      this.scopes.set(name, scope);
      this.report.scopes.push(scope);
    }
    return { name, open: true, queries: 0, writes: 0, unknown: 0 };
  }
  finish(cycle: Cycle, elapsedMs: number): void {
    if (this.closed) return;
    const scope = this.scopes.get(cycle.name);
    if (scope === undefined) return;
    scope.cycles++;
    if (cycle.writes === 0 && cycle.unknown === 0) scope.cyclesWithoutObservedWrites++;
    scope.elapsedMs += elapsedMs;
    scope.maxElapsedMs = Math.max(scope.maxElapsedMs, elapsedMs);
  }
  private receive = (event: unknown): void => {
    const start = performance.now();
    const current = context.getStore();
    const cycle = current?.observer === this ? current.cycle : undefined;
    try {
      if (!isQueryEvent(event)) {
        if (cycle?.open === true) cycle.unknown++;
        this.report.callbackFailures++;
        return;
      }
      let matches = this.locations.get(event.database);
      if (matches === undefined) {
        matches = event.database.location() === this.database;
        this.locations.set(event.database, matches);
      }
      if (!matches) {
        this.report.ignoredDatabaseEvents++;
        return;
      }
      this.report.queryEvents++;
      const ns = Number(event.duration);
      if (!Number.isFinite(ns) || ns < 0) {
        if (cycle?.open === true) cycle.unknown++;
        this.report.callbackFailures++;
        return;
      }
      if (ns === 0) this.report.zeroDurationCount++;
      if (event.sql.length > 65536) {
        if (cycle?.open === true) cycle.unknown++;
        this.report.droppedEvents++;
        return;
      }
      const shape = sqlShape(event.sql);
      const scope = cycle?.name ?? "unattributed";
      const stats = this.scopes.get(scope);
      const kind = statementKind(shape);
      if (stats !== undefined) {
        stats.queryEvents++;
        if (kind === "write") stats.writeEvents++;
        if (kind === "unknown") stats.unclassifiedEvents++;
      }
      if (cycle?.open === true) {
        cycle.queries++;
        if (kind === "write") cycle.writes++;
        if (kind === "unknown") cycle.unknown++;
      }
      const fingerprint = createHash("sha256").update(shape).digest("hex");
      const key = scope + ":" + fingerprint;
      let group = this.groups.get(key);
      if (group === undefined) {
        const retainedShape = shape.slice(0, 2048);
        if (this.groups.size >= 256 || this.retained + retainedShape.length > 524288) {
          this.report.droppedEvents++;
          return;
        }
        this.retained += retainedShape.length;
        group = create(PerformanceQuerySchema, {
          scope,
          fingerprint,
          sqlShape: retainedShape,
          shapeTruncated: shape.length > retainedShape.length,
        });
        this.groups.set(key, group);
        this.report.queries.push(group);
      }
      group.count++;
      group.runtimeMs += ns / 1e6;
      group.maxRuntimeMs = Math.max(group.maxRuntimeMs, ns / 1e6);
      if (ns === 0) group.zeroDurationCount++;
      if (group.count === 1 || group.count % 100 === 0) {
        const stack = (new Error().stack?.split("\n").slice(1, 13).join("\n") ?? "unavailable").slice(0, 2048);
        const existing = group.stacks.find((sample) => sample.stack === stack);
        if (existing !== undefined) existing.observations++;
        else if (group.stacks.length < 4 && this.retained + stack.length <= 524288) {
          group.stacks.push({
            $typeName: "octomanager.v2.PerformanceStackSample",
            stack,
            observations: 1,
          });
          this.retained += stack.length;
        } else group.droppedStackSamples++;
      }
    } catch {
      if (cycle?.open === true) cycle.unknown++;
      this.report.callbackFailures++;
    } finally {
      this.report.observerElapsedMs += performance.now() - start;
    }
  };
  stop() {
    if (!this.closed) {
      this.closed = true;
      unsubscribe(channel, this.receive);
      if (observers.get(this.directory) === this) observers.delete(this.directory);
      this.report.elapsedMs = performance.now() - this.started;
      this.report.queries.sort((a, b) => b.count - a.count);
    }
    return this.report;
  }
}
