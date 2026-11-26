import { fork, type ChildProcess } from "node:child_process";
import { Store } from "../coordinator/store.js";
import { WorkScheduler, type ScheduledTask } from "../scheduling/work.js";
import {
  activeStates,
  nextReady,
  parseTask,
  retryDelay,
  transition,
  type Job,
  type JobCommand,
  type Snapshot,
  type Status,
} from "./domain.js";
import { cleanText, errorText } from "../text.js";
import {
  createFixture,
  readConflict,
  writeResolution,
  validateResolution,
  finishFixture,
  removeFixture,
} from "./fixture.js";
import { readPullRequest } from "./github.js";
interface Active {
  jobId: string;
  attempt: number;
  child?: ChildProcess;
  childExited?: boolean;
  abort: AbortController;
  exited: Promise<void>;
  killTimer?: NodeJS.Timeout;
}
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
export function transient(error: string): boolean {
  return (
    /\b(429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporarily unavailable|rate limit/i.test(error) &&
    !/auth|credential|login|401|403/i.test(error)
  );
}
export interface JobRuntimeOptions {
  now: () => number;
  workerPath: string;
  model?: string;
  workerEnv?: NodeJS.ProcessEnv;
}
export class JobRuntime {
  private readonly jobWork: ScheduledTask;
  private active: Active | undefined;
  private stopping = false;
  private stopped = false;
  private recoveryPids = new Set<number>();
  private finalSnapshot: Snapshot | undefined;
  private readonly now: () => number;
  constructor(
    private directory: string,
    private store: Store,
    private options: JobRuntimeOptions,
    scheduler: WorkScheduler,
    private changed: () => void,
  ) {
    this.now = options.now;
    this.jobWork = scheduler.task("jobs", () => this.tickJobs());
  }
  recover(): void {
    for (const job of this.store.jobs()) {
      let observedExit = false;
      for (const attempt of job.attempts) {
        if (attempt.pid === undefined || attempt.pid === 0 || attempt.exitObservedAt !== undefined) continue;
        if (processAlive(attempt.pid)) this.recoveryPids.add(attempt.pid);
        else {
          attempt.exitObservedAt = this.now();
          observedExit = true;
        }
      }
      if (observedExit) this.store.save(job, "worker_exit_observed", "Previous worker no longer exists");
      if (!activeStates.includes(job.status)) continue;
      this.store.save(
        {
          ...transition(job, "interrupted", this.now()),
          attempts: job.attempts.map((a, i) =>
            i === job.attempts.length - 1
              ? {
                  ...a,
                  endedAt: this.now(),
                  error: "Coordinator stopped before completion",
                }
              : a,
          ),
          error: "Previous attempt interrupted; retry explicitly after the previous worker exits",
        },
        "interrupted",
        "Coordinator recovery",
      );
    }
  }
  wake(): void {
    this.jobWork.wake();
  }
  checkpointable(): boolean {
    return (
      this.active === undefined &&
      this.recoveryPids.size === 0 &&
      !this.store
        .jobs()
        .some(
          (job) =>
            job.status === "queued" ||
            job.status === "retry_wait" ||
            activeStates.includes(job.status) ||
            job.attempts.some((attempt) => attempt.pid !== undefined && attempt.exitObservedAt === undefined),
        )
    );
  }
  stop(abort = false): void {
    this.stopping = true;
    this.jobWork.close();
    if (abort && this.active !== undefined) this.abort(this.active);
  }
  async close(): Promise<void> {
    this.stop(true);
    if (this.active !== undefined) await this.active.exited;
  }
  finish(): void {
    this.finalSnapshot = { ...this.snapshot(), scheduler: "stopped" };
    this.stopped = true;
  }
  snapshot(): Snapshot {
    if (this.finalSnapshot !== undefined) return this.finalSnapshot;
    const recoveryPid = [...this.recoveryPids][0];
    return {
      scheduler: this.stopped ? "stopped" : this.stopping ? "stopping" : this.store.paused() ? "paused" : "running",
      worker: recoveryPid !== undefined ? "recovering" : this.active !== undefined ? "busy" : "idle",
      jobs: this.store.jobs(),
      events: this.store.events(),
      ...(recoveryPid !== undefined ? { recoveryPid } : {}),
    };
  }
  private notify(): void {
    this.changed();
  }
  private change(
    id: string,
    status: Status,
    detail = "",
    patch: Partial<Job> = {},
    clear: readonly ("error" | "result" | "fixture")[] = [],
  ): Job {
    const job = {
      ...transition(this.store.get(id), status, this.now()),
      ...patch,
    };
    if (clear.includes("error")) delete job.error;
    if (clear.includes("result")) delete job.result;
    if (clear.includes("fixture")) delete job.fixture;
    this.store.save(job, status, detail);
    this.notify();
    return job;
  }
  command(value: JobCommand): Job;
  command(value: unknown): unknown;
  command(value: unknown): unknown {
    if (!record(value)) throw new Error("Expected command object");
    const v = value;
    if (v["op"] === "snapshot") return this.snapshot();
    if (v["op"] === "get" && typeof v["id"] === "string") return this.store.get(v["id"]);
    if (v["op"] === "events") {
      if (v["id"] !== undefined && typeof v["id"] !== "string") throw new Error("Invalid job ID");
      const after = v["after"] ?? 0;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0)
        throw new Error("Invalid event cursor");
      return this.store.events(after, v["id"]);
    }
    if (this.stopping) throw new Error("Coordinator is stopping");
    if (v["op"] === "submit" && typeof v["requestId"] === "string") {
      const job = this.store.submit(parseTask(v["task"]), v["requestId"]);
      this.notify();
      return job;
    }
    if (v["op"] === "pause" || v["op"] === "resume") {
      this.store.setPaused(v["op"] === "pause");
      this.notify();
      return { scheduler: v["op"] === "pause" ? "paused" : "running" };
    }
    if (v["op"] === "cancel" && typeof v["id"] === "string") return this.cancel(v["id"]);
    if (v["op"] === "retry" && typeof v["id"] === "string") {
      if (this.recoveryPids.size > 0 || this.active?.jobId === v["id"])
        throw new Error("Wait for the previous worker to exit before retrying");
      const job = this.store.get(v["id"]);
      if (job.status !== "failed" && job.status !== "interrupted")
        throw new Error("Only failed or interrupted jobs can be retried");
      return this.change(job.id, "queued", "Manual retry", { retryCount: 0, availableAt: this.now() }, [
        "error",
        "result",
        "fixture",
      ]);
    }
    throw new Error("Unsupported command or arguments");
  }
  tick(): void {
    this.jobWork.runNow();
  }
  private tickJobs(): number | undefined {
    if (this.stopping || this.stopped) return undefined;
    for (const pid of this.recoveryPids)
      if (!processAlive(pid)) {
        this.recoveryPids.delete(pid);
        for (const job of this.store.jobs()) {
          if (job.attempts.some((a) => a.pid === pid && a.exitObservedAt === undefined)) {
            job.attempts = job.attempts.map((a) =>
              a.pid === pid && a.exitObservedAt === undefined ? { ...a, exitObservedAt: this.now() } : a,
            );
            this.store.save(job, "worker_exit_observed", "Previous worker no longer exists");
          }
        }
        this.notify();
      }
    // Unresolved inherited PIDs have no child-process exit event in this owner.
    if (this.recoveryPids.size > 0) return this.now() + 100;
    if (this.active !== undefined || this.store.paused()) return undefined;
    const now = this.now();
    const jobs = this.store
      .jobs()
      .map((job) =>
        job.status === "retry_wait" && job.availableAt <= now
          ? this.change(job.id, "queued", "Retry delay elapsed")
          : job,
      );
    const job = nextReady(jobs, now);
    if (job === undefined) {
      const pending = jobs.filter((value) => value.status === "queued" || value.status === "retry_wait");
      return pending.length === 0 ? undefined : Math.min(...pending.map((value) => value.availableAt));
    }
    const claimed = this.change(
      job.id,
      "running",
      "Worker claimed",
      {
        attempts: [...job.attempts, { number: job.attempts.length + 1, startedAt: now }],
      },
      ["error", "result"],
    );
    const active: Active = {
      jobId: job.id,
      attempt: claimed.attempts.length,
      abort: new AbortController(),
      exited: Promise.resolve(),
    };
    this.active = active;
    active.exited = this.run(active).finally(() => {
      if (active.killTimer !== undefined) clearTimeout(active.killTimer);
      if (this.active === active) {
        this.active = undefined;
        this.store.event(active.jobId, "worker_idle", "Worker slot released");
      }
      this.notify();
      if (!this.stopping) this.jobWork.wake();
    });
    return undefined;
  }
  private cancel(id: string): Job {
    const job = this.store.get(id);
    if (job.status === "queued" || job.status === "retry_wait")
      return this.change(id, "cancelled", "Cancelled before dispatch");
    if (job.status === "cancelling") return job;
    if (!activeStates.includes(job.status)) return job;
    const next = this.change(id, "cancelling", "Cancellation requested");
    if (this.active?.jobId === id) this.abort(this.active);
    return next;
  }
  private abort(active: Active): void {
    active.abort.abort();
    if (active.child?.connected === true) active.child.send({ type: "abort" }, () => {});
    if (active.killTimer === undefined) active.killTimer = setTimeout(() => active.child?.kill("SIGKILL"), 5000);
  }
  private async run(active: Active): Promise<void> {
    const outcome: {
      failure?: string;
      result?: string;
      readGithub: boolean;
      done: boolean;
    } = { readGithub: false, done: false };
    let fixture: string | undefined;
    try {
      let job = this.store.get(active.jobId);
      if (job.task.kind === "resolve_conflict") {
        const created = await createFixture(this.directory);
        fixture = created.path;
        if (active.abort.signal.aborted) throw new Error("Operation aborted");
        job = this.change(job.id, "conflicted", created.conflict, { fixture });
      }
      active.abort.signal.throwIfAborted();
      const child = fork(this.options.workerPath, [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, ...this.options.workerEnv },
        execArgv: [],
      });
      active.child = child;
      const pendingTools = new Set<Promise<void>>();
      let outputBytes = 0;
      const deadline = setTimeout(() => {
        outcome.failure = "Attempt deadline exceeded";
        this.abort(active);
      }, 180000);
      const exit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          active.childExited = true;
          if ((!outcome.done || code !== 0) && !active.abort.signal.aborted && outcome.failure === undefined)
            outcome.failure = `Worker exited before completion (${String(signal ?? code)})`;
          resolve();
        });
      });
      child.stderr?.on("data", () => {
        /* WHY: SDK diagnostics can contain provider responses; the structured failure channel is authoritative. */
      });
      child.on("message", (message: unknown) => {
        if (!record(message)) return;
        const m = message;
        if (m["attempt"] !== active.attempt || this.active !== active) return;
        if (m["type"] === "progress" && typeof m["text"] === "string" && outputBytes < 32000) {
          const text = cleanText(m["text"], Math.min(2000, 32000 - outputBytes));
          outputBytes += text.length;
          this.store.event(job.id, "progress", text);
          this.notify();
        } else if (m["type"] === "done" && typeof m["text"] === "string" && !outcome.done) {
          outcome.done = true;
          outcome.result = cleanText(m["text"]);
          if (child.connected) child.send({ type: "result_ack", attempt: active.attempt }, () => {});
        } else if (m["type"] === "failure" && typeof m["error"] === "string" && !outcome.done) {
          outcome.done = true;
          outcome.failure = cleanText(m["error"], 2000);
          if (child.connected) child.send({ type: "result_ack", attempt: active.attempt }, () => {});
        } else if (m["type"] === "tool" && typeof m["id"] === "string" && typeof m["name"] === "string") {
          const work = (async () => {
            try {
              if (active.abort.signal.aborted || this.store.get(job.id).status === "cancelling")
                throw new Error("Job cancelled");
              let response: unknown;
              if (job.task.kind === "summarize_pr" && m["name"] === "read_pull_request") {
                response = await readPullRequest(job.task.url, active.abort.signal);
                outcome.readGithub = true;
              } else if (fixture !== undefined && fixture !== "" && job.task.kind === "resolve_conflict") {
                if (m["name"] === "read_conflict") response = await readConflict(fixture);
                else if (m["name"] === "write_resolution")
                  response = await writeResolution(
                    fixture,
                    typeof m["args"] === "object" && m["args"] !== null && "policy" in m["args"]
                      ? m["args"].policy
                      : undefined,
                  );
                else if (m["name"] === "validate_resolution") response = await validateResolution(fixture);
                else throw new Error("Tool not allowed for this job");
              } else throw new Error("Tool not allowed for this job");
              this.store.event(job.id, "tool", m["name"]);
              this.notify();
              if (child.connected) child.send({ type: "tool_result", id: m["id"], result: response }, () => {});
            } catch (error) {
              if (child.connected) child.send({ type: "tool_result", id: m["id"], error: errorText(error) }, () => {});
            }
          })();
          pendingTools.add(work);
          void work.then(
            () => {
              pendingTools.delete(work);
            },
            (error: unknown) => {
              pendingTools.delete(work);
              outcome.failure = errorText(error);
            },
          );
        }
      });
      // WHY: A child cannot begin model/tool work until its PID is durable for crash recovery.
      job = this.store.get(job.id);
      const attempt = job.attempts.at(-1);
      if (attempt === undefined) throw new Error("Missing worker attempt");
      if (child.pid !== undefined) attempt.pid = child.pid;
      this.store.save(job, "worker_started", `Attempt ${String(active.attempt)}`);
      if (job.status === "conflicted") job = this.change(job.id, "resolving", "Pi is resolving the conflict");
      child.send(
        {
          type: "start",
          attempt: active.attempt,
          task: job.task,
          model: this.options.model ?? "gpt-6.1-terra",
        },
        () => {},
      );
      try {
        await exit;
        await Promise.all(pendingTools);
      } finally {
        clearTimeout(deadline);
      }
      if (!active.abort.signal.aborted && (outcome.failure === undefined || outcome.failure === "")) {
        const result = outcome.result;
        if (!outcome.done || result === undefined || result.trim() === "") throw new Error("Worker returned no result");
        if (fixture !== undefined && fixture !== "")
          outcome.result = `${result}\n\n${await finishFixture(fixture, active.abort.signal)}`;
        else if (!outcome.readGithub) throw new Error("Worker did not read the requested PR");
      }
    } catch (error) {
      outcome.failure = errorText(error);
    } finally {
      const job = this.store.get(active.jobId);
      const attempts = job.attempts.map((a, i) =>
        i === job.attempts.length - 1
          ? {
              ...a,
              endedAt: this.now(),
              ...(active.childExited === true ? { exitObservedAt: this.now() } : {}),
              ...(outcome.failure !== undefined && outcome.failure !== "" ? { error: outcome.failure } : {}),
            }
          : a,
      );
      if (job.status === "cancelling") this.change(job.id, "cancelled", "Worker exited", { attempts });
      else if (this.stopping)
        this.change(job.id, "interrupted", "Coordinator shutdown", {
          attempts,
          error: "Interrupted during shutdown",
        });
      else if ((outcome.failure !== undefined && outcome.failure !== "") || active.abort.signal.aborted) {
        const error = outcome.failure ?? "Attempt aborted";
        const delay = transient(error) ? retryDelay(job.retryCount) : undefined;
        if (delay !== undefined)
          this.change(job.id, "retry_wait", error, {
            attempts,
            error,
            retryCount: job.retryCount + 1,
            availableAt: this.now() + delay,
          });
        else this.change(job.id, "failed", error, { attempts, error });
      } else
        this.change(job.id, "succeeded", "Job completed", {
          attempts,
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
        });
      if (fixture !== undefined && fixture !== "") await removeFixture(this.directory, fixture).catch(() => {});
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
