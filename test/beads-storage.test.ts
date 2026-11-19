import { DatabaseSync } from "node:sqlite";
import { IssueStore } from "../src/issues/store.js";
import { synchronizeIssue } from "../src/issues/storage.js";
import {
  IssueStage,
  Waiting,
  type IssueRecord,
} from "../src/issues/contracts.js";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BeadsIssueRepository } from "../src/issue-storage/beads.js";
import type { IssueContent } from "../src/issues/repository.js";

async function rejected(promise: Promise<unknown>): Promise<string> {
  return await promise.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => {
      if (error instanceof Error) return error.message;
      throw new Error("Unexpected rejection value");
    },
  );
}

function content(): IssueContent {
  return {
    id: randomUUID(),
    ref: {
      provider: "github",
      project: "owner/repo",
      externalId: "1",
      url: "https://github.com/owner/repo/issues/1",
    },
    title: "Storage acceptance",
    body: "Preserve this exact body",
    externalClosed: false,
    comments: [
      {
        id: "github:42",
        revision: "2026-11-19T01:00:00Z",
        author: "reviewer",
        body: "Original comment",
        url: "https://github.com/owner/repo/issues/1#issuecomment-42",
      },
    ],
    updatedAt: Date.now(),
  };
}
test("storage command errors and foreign identities are never interpreted as missing records", async () => {
  const repository = new BeadsIssueRepository(process.cwd(), "bd", () =>
    Promise.reject(new Error("Connection failed")),
  );
  expect(
    await rejected(repository.read(randomUUID(), AbortSignal.timeout(1000))),
  ).toContain("Connection failed");
  const foreign = new BeadsIssueRepository(process.cwd(), "bd", () =>
    Promise.resolve(
      JSON.stringify([
        {
          id: "wrong",
          title: "Foreign",
          status: "open",
          updated_at: "2026-11-19T00:00:00Z",
          metadata: {},
        },
      ]),
    ),
  );
  expect(
    await rejected(foreign.read(randomUUID(), AbortSignal.timeout(1000))),
  ).toContain("Invalid stored issue identity");
});

test.skipIf(process.env["OCTO_BEADS_ACCEPTANCE"] !== "1")(
  "native Beads persists Octo content, replays imports and observes direct edits",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "octo-beads-acceptance-"));
    const binary = process.env["OCTO_MANAGER_BEADS_BINARY"] ?? "bd";
    const native = (...args: string[]) =>
      execFileSync(binary, ["-C", workspace, "--sandbox", ...args], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 15000,
      });
    try {
      execFileSync("git", ["init", "-q", workspace]);
      execFileSync(
        binary,
        [
          "init",
          "--prefix",
          "octo",
          "--skip-agents",
          "--skip-hooks",
          "--non-interactive",
        ],
        { cwd: workspace, encoding: "utf8", timeout: 15000 },
      );
      const repository = new BeadsIssueRepository(workspace, binary);
      const value = content();
      const signal = AbortSignal.timeout(30000);
      expect(await repository.read(value.id, signal)).toBeUndefined();
      await repository.write(
        value,
        signal,
        await repository.read(value.id, signal),
      );
      expect(await repository.read(value.id, signal)).toEqual(value);
      await repository.write(
        value,
        signal,
        await repository.read(value.id, signal),
      );
      expect(await repository.read(value.id, signal)).toEqual(value);
      const db = new DatabaseSync(":memory:");
      try {
        const store = new IssueStore(db, Date.now);
        const record: IssueRecord = {
          ...value,
          root: workspace,
          ownerId: "acceptance",
          stage: IssueStage.Investigation,
          waiting: Waiting.Paused,
          detail: "Acceptance",
          epoch: 0,
          brief: undefined,
          approvedVersion: 0,
          publicationVersion: 0,
          policyHash: "test",
          reviewedComments: [],
          pendingComments: [],
          clarificationRound: 0,
          clarificationDueAt: undefined,
          timeoutPlanned: false,
          prUrl: "",
          prHead: "",
          verifiedHead: "",
          assignmentId: "",
          workspace: "",
          createdAt: value.updatedAt,
          nextAt: 0,
          pollIntervalMs: 60000,
        };
        store.save(record, "enrolled", "Native acceptance");
        store.repository.bind(value, repository.identity);
        await synchronizeIssue(store, record, repository, signal);
        expect(store.repository.ready(value.id)).toBe(true);
      } finally {
        db.close();
      }
      const key = `octo-${value.id}`;
      native("update", key, "--description", "Edited through native CLI");
      native("comments", "add", key, "Comment from another harness");
      native("update", key, "--type", "bug", "--priority", "1");
      const changed = await new BeadsIssueRepository(workspace, binary).read(
        value.id,
        signal,
      );
      expect(changed?.id).toBe(value.id);
      expect(changed?.body).toBe("Edited through native CLI");
      expect(changed?.comments.map((item) => item.body)).toContain(
        "Comment from another harness",
      );
      if (changed === undefined)
        throw new Error("Missing content after restart");
      await repository.write(
        changed,
        signal,
        await repository.read(changed.id, signal),
      );
      const repeated = await repository.read(value.id, signal);
      expect(repeated?.comments).toEqual(changed.comments);
      expect(repeated?.comments).toHaveLength(2);
      const answered = {
        ...changed,
        comments: [
          ...changed.comments,
          {
            id: `local:${randomUUID()}`,
            revision: "operator-revision",
            author: "operator",
            body: "Clarification answer",
            url: changed.ref.url,
          },
        ],
        updatedAt: Date.now(),
      };
      await repository.write(
        answered,
        signal,
        await repository.read(answered.id, signal),
      );
      expect((await repository.read(value.id, signal))?.comments).toHaveLength(
        3,
      );
      await repository.write(
        answered,
        signal,
        await repository.read(answered.id, signal),
      );
      expect((await repository.read(value.id, signal))?.comments).toHaveLength(
        3,
      );
      const expected = await repository.read(value.id, signal);
      native("update", key, "--description", "Concurrent native edit");
      expect(
        await rejected(repository.write(answered, signal, expected)),
      ).toContain("changed during persistence");
      expect((await repository.read(value.id, signal))?.body).toBe(
        "Concurrent native edit",
      );
      const nativeRecord: unknown = JSON.parse(native("show", key, "--json"));
      expect(nativeRecord).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issue_type: "bug", priority: 1 }),
        ]),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);
