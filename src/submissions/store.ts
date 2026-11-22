import type { NotificationRepository } from "../notifications/repository.js";
import type { SafeNotice } from "../security/notifications.js";
import { parseNotice, type Notice } from "./notifications.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  SubmissionState,
  hash,
  parse,
  policyAnalystVersion,
  PolicySchema,
  stockProfiles,
  SubmissionSchema,
  type RepositoryPolicy,
  type PolicyAnalysis,
  type RepositorySnapshot,
  type Submission,
  type SubmissionInput,
} from "./contracts.js";
import { resolveId } from "../tracking/identifiers.js";
import { nextInboxSequence } from "./schema.js";
export class SubmissionStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private event: (kind: string, detail: string) => void,
    private noticesRepository: NotificationRepository,
  ) {}
  reconciliation(id: string): { attempts: number; nextAt: number } {
    const row = this.db
      .prepare(
        "SELECT json_extract(value,'$.attempts') AS attempts,json_extract(value,'$.nextAt') AS nextAt FROM settings WHERE key=?",
      )
      .get(`submission-recovery:${id}`);
    if (row === undefined) return { attempts: 0, nextAt: 0 };
    const attempts = row["attempts"],
      nextAt = row["nextAt"];
    if (
      typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      typeof nextAt !== "number" ||
      !Number.isSafeInteger(nextAt) ||
      nextAt < 0
    )
      throw new Error("Invalid submission recovery state");
    return { attempts, nextAt };
  }
  deferReconciliation(id: string, attempts: number, nextAt: number): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`submission-recovery:${id}`, JSON.stringify({ attempts, nextAt }));
  }
  list(): Submission[] {
    return this.db
      .prepare("SELECT data FROM pr_submissions ORDER BY rowid")
      .all()
      .map((row) => parse(SubmissionSchema, JSON.parse(String(row["data"]))));
  }
  summaryPage(
    before = Number.MAX_SAFE_INTEGER,
    limit = 20,
  ): { items: Record<string, unknown>[]; next: number | undefined } {
    const count = Math.max(1, Math.min(limit, 20));
    const rows = this.db
      .prepare(
        "SELECT rowid,id,state,substr(json_extract(data,'$.detail'),1,160) AS detail,json_extract(data,'$.prUrl') AS url FROM pr_submissions WHERE rowid<? ORDER BY rowid DESC LIMIT ?",
      )
      .all(before, count + 1);
    return {
      items: rows
        .slice(0, count)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "rowid"),
          ),
        ),
      next:
        rows.length > count ? Number(rows[count - 1]?.["rowid"]) : undefined,
    };
  }
  get(id: string): Submission {
    const all = this.list(),
      resolved = resolveId(
        id,
        all.map((item) => item.id),
      );
    const item = all.find((item) => item.id === resolved);
    if (item === undefined) throw new Error("Submission not found");
    return item;
  }
  request(request: SubmissionInput): Submission {
    const existing = this.list().find(
      (item) => item.request.requestId === request.requestId,
    );
    if (existing !== undefined) {
      if (hash(existing.request) !== hash(request))
        throw new Error(
          "Request ID already used with different submission input",
        );
      return existing;
    }
    const at = this.now();
    const value: Submission = {
      id: randomUUID(),
      request,
      state: SubmissionState.Queued,
      detail: "Submission queued",
      createdAt: at,
      updatedAt: at,
      stages: [],
      workerPids: [],
      notificationRevision: 0,
    };
    this.save(value);
    return value;
  }
  save(value: Submission): Submission {
    const updated = { ...value, updatedAt: this.now() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO pr_submissions(id,request_id,digest,state,data,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at_ms=excluded.updated_at_ms",
        )
        .run(
          updated.id,
          updated.request.requestId,
          hash(updated.request),
          updated.state,
          JSON.stringify(updated),
          updated.createdAt,
          updated.updatedAt,
        );
      this.event(
        "submission_progress",
        `${updated.id}: ${updated.state}: ${updated.detail}`,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }
  policies(repository: string): RepositoryPolicy[] {
    return this.db
      .prepare(
        "SELECT data FROM repository_policies WHERE repository=? ORDER BY version",
      )
      .all(repository.toLowerCase())
      .map((row) => {
        const policy = parse(PolicySchema, JSON.parse(String(row["data"])));
        return {
          ...policy,
          complexityProfiles: policy.complexityProfiles ?? stockProfiles,
        };
      });
  }
  policy(repository: string, version?: number): RepositoryPolicy | undefined {
    const all = this.policies(repository);
    return version === undefined
      ? all.at(-1)
      : all.find((policy) => policy.version === version);
  }
  cached(snapshot: RepositorySnapshot): RepositoryPolicy | undefined {
    return this.policies(snapshot.repository).findLast(
      (policy) =>
        policy.sourceDigest === snapshot.sourceDigest &&
        policy.analystVersion === policyAnalystVersion,
    );
  }
  savePolicy(
    snapshot: RepositorySnapshot,
    analysis: PolicyAnalysis,
    citationCorrections: NonNullable<
      RepositoryPolicy["citationCorrections"]
    > = [],
  ): RepositoryPolicy {
    const value: RepositoryPolicy = {
      schemaVersion: 1,
      repository: snapshot.repository,
      version: (this.policy(snapshot.repository)?.version ?? 0) + 1,
      sourceDigest: snapshot.sourceDigest,
      analystVersion: policyAnalystVersion,
      stockVersion: 1,
      citationCorrections,
      complexityProfiles: stockProfiles,
      createdAtMs: this.now(),
      sources: snapshot.sources,
      analysis,
    };
    this.db
      .prepare(
        "INSERT INTO repository_policies(repository,version,source_digest,data,created_at_ms) VALUES(?,?,?,?,?)",
      )
      .run(
        value.repository,
        value.version,
        value.sourceDigest,
        JSON.stringify(value),
        value.createdAtMs,
      );
    this.event(
      "repository_policy_versioned",
      `${value.repository}: policy v${String(value.version)}`,
    );
    return value;
  }
  recoverNotices(): void {
    this.db
      .prepare(
        "UPDATE operation_notifications SET state='uncertain' WHERE state='sending'",
      )
      .run();
  }
  notices(includeAcknowledged = false): Notice[] {
    return this.db
      .prepare(
        "SELECT id,submission_id AS submissionId,recipient_agent_id AS recipient,body,state,attempts,next_check_at_ms AS nextCheckAt FROM operation_notifications WHERE (?=1 OR acknowledged_at_ms IS NULL) AND applicable=1 ORDER BY sequence",
      )
      .all(includeAcknowledged ? 1 : 0)
      .map((row) =>
        parseNotice({
          ...row,
          attempts: JSON.parse(String(row["attempts"])) as unknown,
        }),
      );
  }
  noticeApplicable(id: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT id FROM operation_notifications WHERE id=? AND applicable=1 AND acknowledged_at_ms IS NULL",
        )
        .get(id) !== undefined
    );
  }
  saveNotice(
    notice: Notice,
    state: Notice["state"],
    detail: string,
    at: number,
  ): void {
    const row = this.db
      .prepare(
        "SELECT id,submission_id AS submissionId,recipient_agent_id AS recipient,body,state,attempts,next_check_at_ms AS nextCheckAt FROM operation_notifications WHERE id=?",
      )
      .get(notice.id);
    const current =
      row === undefined
        ? undefined
        : parseNotice({
            ...row,
            attempts: JSON.parse(String(row["attempts"])) as unknown,
          });
    if (current === undefined) return;
    const attempts = [
      ...current.attempts,
      { at: this.now(), state, detail },
    ].slice(-100);
    this.db
      .prepare(
        "UPDATE operation_notifications SET state=?,attempts=?,next_check_at_ms=?,error=? WHERE id=?",
      )
      .run(
        state,
        JSON.stringify(attempts),
        at,
        state === "uncertain" ? detail : null,
        notice.id,
      );
  }
  invalidateNotices(id: string): void {
    this.db
      .prepare(
        "UPDATE operation_notifications SET applicable=0 WHERE submission_id=?",
      )
      .run(id);
  }
  notify(value: Submission, agentId: string): void {
    if (
      this.db
        .prepare(
          "SELECT id FROM operation_notifications WHERE submission_id=? AND applicable=1",
        )
        .get(value.id) !== undefined
    )
      return;
    const id = this.noticesRepository.newMessageId();
    const notice: SafeNotice = {
      version: 1,
      kind: "submission",
      assessment: "not_required",
      subject: { kind: "submission", id: value.id },
      ...(value.prUrl === undefined ? {} : { prUrl: value.prUrl }),
    };
    this.noticesRepository.freezeNotice(id, notice);
    this.db
      .prepare(
        "INSERT INTO operation_notifications(sequence,id,submission_id,recipient_agent_id,body,created_at_ms,next_check_at_ms,applicable,state,attempts) VALUES(?,?,?,?,?,?,?,1,'pending','[]')",
      )
      .run(
        nextInboxSequence(this.db),
        id,
        value.id,
        agentId,
        this.noticesRepository.render(id, notice),
        this.now(),
        this.now(),
      );
    this.event("submission_notification", value.id);
  }
}
