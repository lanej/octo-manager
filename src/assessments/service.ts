import { type WorkScheduler, type ScheduledTask } from "../scheduling/work.js";
import { inputLimit, policyVersion, result, type Assessment, type AssessmentInput } from "./contracts.js";
import { AssessmentStore } from "./store.js";
import { assessmentRunner, type Assess } from "./runner.js";
import type { TrackingService } from "../tracking/service.js";
import { unfinished, type Action } from "../tracking/types.js";
import { successfulCheck } from "../tracking/checks.js";

function eligible(action: Action): boolean {
  const b = action.blocker;
  return (
    b.kind === "review_feedback" ||
    b.kind === "check_failed" ||
    (b.kind === "check_results" && b.checks.some((check) => !successfulCheck(check)))
  );
}

export function boundedInput(
  action: Action,
  prUrl: string,
  headSha: string,
  excerpt?: string,
  epoch = 0,
): AssessmentInput {
  let evidence = JSON.stringify({
    blocker: action.blocker,
    ...(excerpt === undefined ? {} : { failedLogExcerpt: excerpt }),
  });
  const input: AssessmentInput = {
    actionId: action.id,
    prUrl,
    headSha,
    sourceKey: action.sourceKey,
    policyVersion,
    epoch,
    evidence,
    truncated: false,
  };
  while (Buffer.byteLength(JSON.stringify(input)) > inputLimit) {
    evidence = evidence.slice(0, Math.floor(evidence.length * 0.8));
    input.evidence = evidence;
    input.truncated = true;
    if (evidence.length === 0) throw new Error("Assessment metadata exceeds input bound");
  }
  return input;
}

export class AssessmentService {
  private work: Promise<void> | undefined;
  private task: ScheduledTask | undefined;
  private stopped = false;
  private abort = new AbortController();

  constructor(
    readonly store: AssessmentStore,
    private tracking: TrackingService,
    private model = "gpt-6.1-terra",
    private assess: Assess = assessmentRunner(),
    private now: () => number = Date.now,
  ) {}

  start(scheduler: WorkScheduler): void {
    this.task = scheduler.task("assessments", () => this.tick());
    this.task.wake();
  }

  wake(): void {
    this.task?.wake();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.synchronize();
    if (this.work) return this.work;
    const item = this.store.reconciliationCandidates().find((item) => item.state === "pending");
    if (!item) return Promise.resolve();
    this.work = this.run(item).finally(() => {
      this.work = undefined;
      this.task?.wake();
    });
    return this.work;
  }

  private current(item: Assessment): boolean {
    const action = this.tracking.store.action(item.input.actionId),
      pr = this.tracking.store.pr(action.prId);
    return (
      item.input.epoch === pr.trackingEpoch &&
      pr.enabled &&
      unfinished(action) &&
      pr.observation?.headSha === item.input.headSha &&
      action.sourceKey === item.input.sourceKey &&
      this.store.latest(action.id)?.id === item.id
    );
  }

  private synchronize(): void {
    for (const item of this.store.reconciliationCandidates())
      if (item.state !== "superseded" && !this.current(item)) {
        this.tracking.store.transaction(() => {
          this.store.save({
            ...item,
            state: "superseded",
            updatedAt: this.now(),
          });
          this.tracking.store.cancelAssessmentNotices(item.id);
        });
      }
    for (const action of this.tracking.store.unfinishedActions()) {
      if (!eligible(action) || !unfinished(action)) continue;
      const pr = this.tracking.store.pr(action.prId);
      if (pr.enabled && pr.observation)
        this.store.ensure(
          boundedInput(action, pr.url, pr.observation.headSha, undefined, pr.trackingEpoch),
          this.model,
        );
    }
    for (const item of this.store.reconciliationCandidates()) {
      if (
        item.completionNotified ||
        !this.current(item) ||
        (item.state !== "completed" && item.state !== "failed" && item.state !== "interrupted")
      )
        continue;
      this.tracking.store.transaction(() => {
        this.tracking.store.notifyAssessment(
          this.tracking.store.action(item.input.actionId),
          item.state === "completed" ? "completed" : "unavailable",
          { id: item.id, head: item.input.headSha },
        );
        this.store.save({ ...item, completionNotified: true });
      });
    }
  }

  private async run(item: Assessment): Promise<void> {
    try {
      const action = this.tracking.store.action(item.input.actionId);
      let input = item.input;
      if (!item.history.some((entry) => entry.state === "running")) {
        const excerpt = await this.tracking.failureExcerpt(
          action,
          item.input.prUrl,
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
        );
        input = boundedInput(action, item.input.prUrl, item.input.headSha, excerpt, item.input.epoch);
      }
      if (this.stopped || !this.current(item)) return;
      this.store.save({
        ...item,
        input,
        state: "running",
        updatedAt: this.now(),
      });
      const output = result(await this.assess(input, item.model, this.abort.signal));
      if (!this.abort.signal.aborted && this.current(item))
        this.store.save({
          ...this.store.get(item.id),
          state: "completed",
          result: output,
          updatedAt: this.now(),
        });
    } catch {
      if (this.current(item))
        this.store.save({
          ...this.store.get(item.id),
          state: this.stopped ? "interrupted" : "failed",
          updatedAt: this.now(),
        });
    } finally {
      if (!this.stopped) this.synchronize();
    }
  }

  retry(id: string): Assessment {
    const item = this.store.get(id);
    if (!this.current(item)) throw new Error("Assessment no longer applies");
    if (this.stopped) throw new Error("Coordinator is stopping");
    return this.tracking.store.transaction(() => {
      const next = this.store.retry(id);
      this.tracking.store.notifyAssessment(this.tracking.store.action(item.input.actionId), "pending", {
        id: item.id,
        head: item.input.headSha,
      });
      return next;
    });
  }

  checkpointable(): boolean {
    return (
      this.work === undefined &&
      !this.store.reconciliationCandidates().some((item) => item.state === "pending" || item.state === "running")
    );
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.task?.close();
    this.abort.abort();
    await this.work;
  }
}
