import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Code, ConnectError } from "@connectrpc/connect";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";

test(
  "Watch delivers new events when unrelated full snapshot data is unreadable",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-watch-idle-"));
    const coordinator = new Coordinator(directory);
    const abort = new AbortController();
    let database: DatabaseSync | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await coordinator.start();
      coordinator.command({ op: "pause" });
      database = new DatabaseSync(join(directory, "jobs.sqlite"));
      database
        .prepare("INSERT INTO jobs(id,request_id,data) VALUES(?,?,?)")
        .run("unrelated-unreadable-job", "watch-history-fixture", "not-json");
      const client = schedulerClient(directory);
      await assert.rejects(
        client.getSnapshot({}),
        (error: unknown) =>
          error instanceof ConnectError && error.code === Code.Internal,
      );
      const cursor = BigInt(coordinator.store.sequence());
      const events = client.watch(
        {
          instanceId: coordinator.store.instanceId(),
          afterSequence: cursor,
        },
        { signal: abort.signal },
      );
      const stream = events[Symbol.asyncIterator]();
      timer = setTimeout(() => {
        coordinator.store.event("", "watch_probe", "new event after cursor");
      }, 150);
      const result = await stream.next();
      assert.equal(result.done, false);
      assert.equal(result.value.event?.kind, "watch_probe");
      assert.equal(result.value.event.sequence, cursor + 1n);
      abort.abort();
      await stream.return?.();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
      database
        ?.prepare("DELETE FROM jobs WHERE id=?")
        .run("unrelated-unreadable-job");
      database?.close();
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  process.env["CI"] === undefined ? 2000 : 10000,
);
