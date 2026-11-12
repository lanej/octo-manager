import { parseNotice, type Notice } from "./notifications.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  SubmissionState,
  hash,
  parse,
  PolicySchema,
  stockProfiles,
  SubmissionSchema,
  type RepositoryPolicy,
  type PolicyAnalysis,
  type RepositorySnapshot,
  type Submission,
  type SubmissionInput,
} from "./contracts.js";
import { resolveId, shortId } from "../tracking/identifiers.js";
import { nextInboxSequence } from "./schema.js";
export class SubmissionStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private event: (kind: string, detail: string) => void,
  ) {}
  list(): Submission[] {
    return this.db
      .prepare("SELECT data FROM pr_submissions ORDER BY rowid")
      .all()
      .map((row) => parse(SubmissionSchema, JSON.parse(String(row["data"]))));
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
      (policy) => policy.sourceDigest === snapshot.sourceDigest,
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
      analystVersion: 1,
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
  notify(value: Submission, agentId: string, body: string): void {
    if (
      this.db
        .prepare(
          "SELECT id FROM operation_notifications WHERE submission_id=? AND applicable=1",
        )
        .get(value.id) !== undefined
    )
      return;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO operation_notifications(sequence,id,submission_id,recipient_agent_id,body,created_at_ms,next_check_at_ms,applicable,state,attempts) VALUES(?,?,?,?,?,?,?,1,'pending','[]')",
      )
      .run(
        nextInboxSequence(this.db),
        id,
        value.id,
        agentId,
        `[octo-delivery:${shortId(
          id,
          this.db
            .prepare(
              "SELECT delivery_id AS id FROM delivery_messages UNION ALL SELECT id FROM operation_notifications",
            )
            .all()
            .map((row) => String(row["id"])),
        )}]\n${body}\nSubmission: ${shortId(
          value.id,
          this.list().map((item) => item.id),
        )}`,
        this.now(),
        this.now(),
      );
    this.event("submission_notification", value.id);
  }
}
