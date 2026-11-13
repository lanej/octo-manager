import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { nextInboxSequence } from "../submissions/schema.js";
import { compact } from "./messages.js";
import { shortId } from "./identifiers.js";
import type { AgentRef, TrackedPR } from "./types.js";
export enum ParticipantRole {
  Owner = "owner",
  Observer = "observer",
}
export interface Participant {
  agentId: string;
  role: ParticipantRole;
  label: string;
  harness: string;
}
export function migrateSubscriptions(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 12) return;
  if (version !== 11)
    throw new Error("Unsupported subscription database version");
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS pr_subscriptions (
      pr_id TEXT NOT NULL REFERENCES tracked_prs(id),agent_id TEXT NOT NULL REFERENCES agent_refs(id),created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(pr_id,agent_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS subscriptions_by_agent ON pr_subscriptions(agent_id,pr_id);
    CREATE TABLE IF NOT EXISTS pr_participant_revisions(pr_id TEXT PRIMARY KEY REFERENCES tracked_prs(id),revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
    CREATE TABLE IF NOT EXISTS participant_messages (
      sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,pr_id TEXT NOT NULL REFERENCES tracked_prs(id),
      recipient_agent_id TEXT NOT NULL REFERENCES agent_refs(id),revision INTEGER NOT NULL,body TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,acknowledged_at_ms INTEGER,next_check_at_ms INTEGER NOT NULL,
      UNIQUE(pr_id,recipient_agent_id,revision)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_participant_message BEFORE UPDATE OF sequence,id,pr_id,recipient_agent_id,revision,body,created_at_ms ON participant_messages BEGIN SELECT RAISE(ABORT,'Participant message is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS monotonic_participant_receipt BEFORE UPDATE OF acknowledged_at_ms ON participant_messages WHEN OLD.acknowledged_at_ms IS NOT NULL AND NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms BEGIN SELECT RAISE(ABORT,'Participant receipt is immutable'); END;
    PRAGMA user_version=12;COMMIT;`);
}
export class Subscriptions {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private agent: (id: string) => AgentRef,
  ) {}
  includes(prId: string, agentId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM tracked_prs WHERE id=? AND (owner_agent_id=? OR EXISTS(SELECT 1 FROM pr_subscriptions WHERE pr_id=tracked_prs.id AND agent_id=?))",
        )
        .get(prId, agentId, agentId) !== undefined
    );
  }
  list(pr: TrackedPR): Participant[] {
    const ids = [
      pr.ownerAgentId,
      ...this.db
        .prepare(
          "SELECT agent_id FROM pr_subscriptions WHERE pr_id=? AND agent_id!=? ORDER BY created_at_ms,agent_id",
        )
        .all(pr.id, pr.ownerAgentId)
        .map((row) => String(row["agent_id"])),
    ];
    return ids.map((id) => {
      const agent = this.agent(id);
      return {
        agentId: id,
        role:
          id === pr.ownerAgentId
            ? ParticipantRole.Owner
            : ParticipantRole.Observer,
        label: compact(
          agent.label ?? `${agent.harness} ${shortId(id, ids)}`,
          120,
        )
          .replaceAll("\n", " ")
          .replaceAll("\t", " "),
        harness: agent.harness,
      };
    });
  }
  addInside(pr: TrackedPR, agentId: string): boolean {
    if (!pr.enabled)
      throw new Error(
        "PR tracking is disabled; only explicit tracking can resume it",
      );
    if (pr.ownerAgentId === agentId) return false;
    return (
      Number(
        this.db
          .prepare("INSERT OR IGNORE INTO pr_subscriptions VALUES(?,?,?)")
          .run(pr.id, agentId, this.now()).changes,
      ) > 0
    );
  }
  removeInside(pr: TrackedPR, agentId: string): boolean {
    if (pr.ownerAgentId === agentId)
      throw new Error(
        "Owner cannot unsubscribe; assign ownership or untrack the PR",
      );
    return (
      Number(
        this.db
          .prepare("DELETE FROM pr_subscriptions WHERE pr_id=? AND agent_id=?")
          .run(pr.id, agentId).changes,
      ) > 0
    );
  }
  publishInside(pr: TrackedPR): void {
    if (!this.db.isTransaction)
      throw new Error("Participant update requires a coordinator transaction");
    this.db
      .prepare(
        "INSERT INTO pr_participant_revisions VALUES(?,1) ON CONFLICT(pr_id) DO UPDATE SET revision=revision+1",
      )
      .run(pr.id);
    const revision = Number(
      this.db
        .prepare("SELECT revision FROM pr_participant_revisions WHERE pr_id=?")
        .get(pr.id)?.["revision"],
    );
    const participants = this.list(pr),
      number = new URL(pr.url).pathname.split("/").at(-1) ?? "";
    for (const recipient of participants) {
      const priority = participants.filter(
        (item) =>
          item.role === ParticipantRole.Owner ||
          item.agentId === recipient.agentId,
      );
      const visible = [
        ...priority,
        ...participants
          .filter((item) => !priority.includes(item))
          .slice(0, 8 - priority.length),
      ];
      const body = `[PR #${number}](${pr.url}) · Participants changed\n${visible
        .map(
          (item) =>
            `> ${item.role}: ${item.label} (${shortId(
              item.agentId,
              participants.map((p) => p.agentId),
            )})${item.agentId === recipient.agentId ? " · you" : ""}`,
        )
        .join(
          "\n",
        )}\n${participants.length > visible.length ? `> +${String(participants.length - visible.length)} more; use octo-manager participants ${pr.url} for the roster\n` : ""}`;
      this.db
        .prepare("INSERT INTO participant_messages VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          nextInboxSequence(this.db),
          randomUUID(),
          pr.id,
          recipient.agentId,
          revision,
          body,
          this.now(),
          null,
          this.now(),
        );
    }
  }
}
