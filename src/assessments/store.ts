import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  assessment,
  policyVersion,
  type Assessment,
  type AssessmentInput,
} from "./contracts.js";
import { resolveId } from "../tracking/identifiers.js";
export class AssessmentStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {}
  recoverInterrupted(): void {
    for (const item of this.list())
      if (item.state === "running")
        this.save({ ...item, state: "interrupted", updatedAt: this.now() });
  }
  list(): Assessment[] {
    return this.db
      .prepare("SELECT data FROM evidence_assessments ORDER BY rowid")
      .all()
      .map((row) => assessment(JSON.parse(String(row["data"]))));
  }
  get(id: string): Assessment {
    const items = this.list(),
      full = resolveId(
        id,
        items.map((item) => item.id),
      );
    const item = items.find((item) => item.id === full);
    if (item === undefined) throw new Error("Assessment not found");
    return item;
  }
  latest(actionId: string): Assessment | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM evidence_assessments WHERE action_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(actionId);
    return row === undefined
      ? undefined
      : assessment(JSON.parse(String(row["data"])));
  }
  ensure(input: AssessmentInput, model: string): Assessment {
    const row = this.db
      .prepare(
        "SELECT data FROM evidence_assessments WHERE action_id=? AND json_extract(data,'$.state')!='superseded' AND json_extract(data,'$.input.sourceKey')=? AND json_extract(data,'$.input.headSha')=? AND COALESCE(json_extract(data,'$.input.epoch'),-1)=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(input.actionId, input.sourceKey, input.headSha, input.epoch ?? -1);
    if (row !== undefined) return assessment(JSON.parse(String(row["data"])));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          actionId: input.actionId,
          sourceKey: input.sourceKey,
          headSha: input.headSha,
          epoch: input.epoch,
          policyVersion,
          previous: this.latest(input.actionId)?.id,
        }),
      )
      .digest("hex");
    const item: Assessment = {
      id: randomUUID(),
      input,
      fingerprint,
      model,
      state: "pending",
      createdAt: this.now(),
      updatedAt: this.now(),
      completionNotified: false,
      history: [],
    };
    this.save(item);
    return item;
  }
  save(item: Assessment): void {
    assessment(item);
    const row = this.db
      .prepare("SELECT data FROM evidence_assessments WHERE id=?")
      .get(item.id);
    const previous =
      row === undefined
        ? undefined
        : assessment(JSON.parse(String(row["data"])));
    const next = {
      ...item,
      history:
        previous?.state === item.state
          ? previous.history
          : [
              ...(previous?.history ?? []),
              { state: item.state, at: this.now() },
            ],
    };
    this.db
      .prepare(
        "INSERT INTO evidence_assessments(id,action_id,fingerprint,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        item.id,
        item.input.actionId,
        item.fingerprint,
        JSON.stringify(next),
      );
  }
  retry(id: string): Assessment {
    const item = this.get(id);
    if (item.state !== "failed" && item.state !== "interrupted")
      throw new Error("Only failed or interrupted assessments can be retried");
    const next: Assessment = {
      ...item,
      state: "pending",
      updatedAt: this.now(),
      completionNotified: false,
    };
    delete next.result;
    this.save(next);
    return next;
  }
}
