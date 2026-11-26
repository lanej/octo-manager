import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { schedulerClient } from "../src/client.js";
import { createApplicationFixture } from "./support/application.js";
import { digest, type Job } from "../src/jobs/domain.js";
import { GetSnapshotResponseSchema } from "../src/gen/octomanager/v2/scheduler_pb.js";

test(
  "retained snapshots cross 4 MiB while responses remain bounded",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-snapshot-size-"));
    const coordinator = await createApplicationFixture(directory);
    let database: DatabaseSync | undefined;
    try {
      await coordinator.start();
      coordinator.command({ op: "pause" });
      database = new DatabaseSync(join(directory, "jobs.sqlite"));
      const insert = database.prepare(
        "INSERT INTO jobs(id,request_id,data) VALUES(?,?,?)",
      );
      const result = "r".repeat(16000);
      const addJobs = (count: number) => {
        assert.ok(database !== undefined);
        database.exec("BEGIN");
        for (let i = 0; i < count; i++) {
          const id = randomUUID();
          const job: Job = {
            id,
            requestId: id,
            digest: digest({ kind: "resolve_conflict" }),
            task: { kind: "resolve_conflict" },
            status: "succeeded",
            createdAt: 1,
            updatedAt: 2,
            availableAt: 1,
            attempts: [
              { number: 1, startedAt: 1, endedAt: 2, exitObservedAt: 2 },
            ],
            retryCount: 0,
            result,
          };
          insert.run(id, id, JSON.stringify(job));
        }
        database.exec("COMMIT");
      };
      addJobs(320);
      const client = schedulerClient(directory);
      const response = await client.getSnapshot({});
      assert.equal(response.snapshot?.jobs.length, 320);
      assert.equal(response.snapshot.jobs.at(-1)?.resultMarkdown, result);
      assert.ok(
        toBinary(GetSnapshotResponseSchema, response).byteLength >
          4 * 1024 * 1024,
      );
      addJobs(800);
      await assert.rejects(
        client.getSnapshot({}),
        (error: unknown) =>
          error instanceof ConnectError &&
          error.code === Code.ResourceExhausted,
      );
    } finally {
      database?.exec("DELETE FROM jobs");
      database?.close();
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  process.env["CI"] === undefined ? 3000 : 10000,
);
