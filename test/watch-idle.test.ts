import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Code, ConnectError } from "@connectrpc/connect";
import { createApplicationFixture } from "./support/application.js";
import { schedulerClient } from "../src/client.js";
import type { WatchResponse } from "../src/gen/octomanager/v2/scheduler_pb.js";

async function nextEvent(stream: AsyncIterator<WatchResponse>) {
  const result = await stream.next();
  if (result.done === true)
    throw new Error("Watch stream ended before its next event");
  return result.value;
}

test(
  "Watch delivers new events when unrelated full snapshot data is unreadable",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-watch-idle-"));
    const coordinator = await createApplicationFixture(directory);
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

test(
  "Watch sleeps after draining, ignores rollback and wakes across the subscribe/read race",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-watch-events-"));
    const application = await createApplicationFixture(directory);
    const abort = new AbortController();
    const read = application.store.eventsSince.bind(application.store);
    let reads = 0;
    let appendDuringRead = false;
    application.store.eventsSince = (...args) => {
      reads++;
      const events = read(...args);
      if (appendDuringRead) {
        appendDuringRead = false;
        application.store.event(
          "",
          "racing_append",
          "committed after cursor read",
        );
      }
      return events;
    };
    try {
      await application.start();
      application.command({ op: "pause" });
      await Bun.sleep(20);
      const cursor = BigInt(application.store.sequence());
      const client = schedulerClient(directory);
      const updates = client.watch(
        {
          instanceId: application.store.instanceId(),
          afterSequence: cursor,
        },
        { signal: abort.signal },
      );
      const stream = updates[Symbol.asyncIterator]();
      const pending = nextEvent(stream);
      // Cleanup can cancel this idle pull after an assertion fails.
      pending.catch(() => undefined);
      const deadline = Date.now() + 1000;
      while (reads === 0 && Date.now() < deadline) await Bun.sleep(5);
      assert.equal(reads, 1, "Watch must initially drain its durable cursor");
      await Bun.sleep(175);
      assert.equal(reads, 1, "an idle Watch must not repeatedly query SQLite");
      assert.throws(
        () =>
          application.store.tracking.transaction(() => {
            application.store.event("", "rolled_back", "must never publish");
            throw new Error("rollback probe");
          }),
        /rollback probe/,
      );
      await Bun.sleep(25);
      assert.equal(reads, 1, "a rolled-back append must not wake consumers");
      appendDuringRead = true;
      application.store.event("", "first_append", "wake the sleeping consumer");
      const first = await pending;
      assert.equal(first.event?.kind, "first_append");
      const racing = await nextEvent(stream);
      assert.equal(racing.event?.kind, "racing_append");
      assert.equal(racing.event.sequence, cursor + 2n);
      abort.abort();
      await stream.return?.();
    } finally {
      abort.abort();
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  process.env["CI"] === undefined ? 2000 : 10000,
);

test(
  "Watch drains multiple pages and preserves each client's filter and cursor",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-watch-pages-"));
    const application = await createApplicationFixture(directory);
    const abort = new AbortController();
    try {
      await application.start();
      application.command({ op: "pause" });
      const cursor = BigInt(application.store.sequence());
      for (let index = 0; index < 205; index++)
        application.store.event("first-job", "page_probe", String(index));
      application.store.event("other-job", "other_probe", "independent filter");
      const client = schedulerClient(directory);
      const firstUpdates = client.watch(
        {
          instanceId: application.store.instanceId(),
          afterSequence: cursor,
          jobId: "first-job",
        },
        { signal: abort.signal },
      );
      const first = firstUpdates[Symbol.asyncIterator]();
      const otherUpdates = client.watch(
        {
          instanceId: application.store.instanceId(),
          afterSequence: cursor,
          jobId: "other-job",
        },
        { signal: abort.signal },
      );
      const other = otherUpdates[Symbol.asyncIterator]();
      for (let index = 0; index < 205; index++) {
        const result = await nextEvent(first);
        assert.equal(result.event?.detail, String(index));
        assert.equal(result.event.sequence, cursor + BigInt(index + 1));
      }
      const result = await nextEvent(other);
      assert.equal(result.event?.kind, "other_probe");
      assert.equal(result.event.sequence, cursor + 206n);
      abort.abort();
      await first.return?.();
      await other.return?.();
    } finally {
      abort.abort();
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  process.env["CI"] === undefined ? 2000 : 10000,
);
