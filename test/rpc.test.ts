import { present } from "./support/present.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { createApplicationFixture } from "./support/application.js";
import { schedulerClient } from "../src/client.js";
import { JobStatus } from "../src/gen/octomanager/v2/scheduler_pb.js";

const code = (expected: Code) => (error: unknown) => error instanceof ConnectError && error.code === expected;
test("generated Connect contract has typed failures, atomic snapshot cursors, replay and bounded pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "om-"));
  const coordinator = await createApplicationFixture(directory, {
    reviewReader: (url) =>
      Promise.resolve({
        url,
        title: "Controlled PR",
        state: "open",
        headSha: "abc",
        observedAtMs: 1234,
        messages: [
          {
            id: "review:1",
            url,
            author: "reviewer",
            kind: "review",
            state: "APPROVED",
            bodyMarkdown: "Looks good",
            atMs: 1233,
            path: "",
            commitSha: "abc",
            bodyTruncated: false,
          },
        ],
        mayHaveMoreMessages: false,
      }),
  });
  try {
    await coordinator.start();
    coordinator.command({ op: "pause" });
    const client = schedulerClient(directory);
    const before = present((await client.getSnapshot({})).snapshot);
    assert(before.githubUsage !== undefined);
    assert(before.githubUsage.sampledAtMs >= before.githubUsage.startedAtMs);
    assert(before.githubUsage.minutes.length >= 1);
    assert(before.allowedTransitions.some((edge) => edge.from === JobStatus.QUEUED && edge.to === JobStatus.RUNNING));
    assert(
      !before.allowedTransitions.some((edge) => edge.from === JobStatus.QUEUED && edge.to === JobStatus.SUCCEEDED),
    );
    const review = await client.getPullRequest({ url: "https://github.com/owner/repo/pull/12" });
    assert.equal(review.pullRequest, undefined);
    coordinator.githubScheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const cached = await client.getPullRequest({ url: "https://github.com/owner/repo/pull/12" });
    const details = cached.pullRequest;
    assert.ok(details !== undefined);
    assert.equal(details.messages[0]?.bodyMarkdown, "Looks good");
    assert.equal(details.observedAtMs, 1234n);
    await assert.rejects(client.getPullRequest({ url: "file:///etc/passwd" }), code(Code.InvalidArgument));
    await assert.rejects(client.submitJob({ requestId: "bad", task: {} }), code(Code.InvalidArgument));
    const request = { requestId: "one", task: { kind: { case: "resolveConflict" as const, value: {} } } };
    const accepted = present((await client.submitJob(request)).job);
    assert.equal(present((await client.submitJob(request)).job).id, accepted.id);
    await assert.rejects(
      client.submitJob({
        requestId: "one",
        task: {
          kind: { case: "summarizePullRequest", value: { url: "https://github.com/earendil-works/pi/pull/11546" } },
        },
      }),
      code(Code.AlreadyExists),
    );
    await assert.rejects(client.getJob({ id: "missing" }), code(Code.NotFound));
    const subscription = client.watch({ instanceId: before.instanceId, afterSequence: before.sequence });
    const stream = subscription[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.ok(first.done !== true);
    const firstEvent = present(first.value.event);
    assert.equal(firstEvent.jobId, accepted.id);
    assert.equal(firstEvent.kind, "queued");
    await stream.return?.();
    assert.equal(present((await client.getJob({ id: accepted.id })).job).status, JobStatus.QUEUED);
    const wrong = client.watch({ instanceId: "replaced-state", afterSequence: 0n })[Symbol.asyncIterator]();
    await assert.rejects(wrong.next(), code(Code.FailedPrecondition));
    const future = client.watch({ instanceId: before.instanceId, afterSequence: 999999n })[Symbol.asyncIterator]();
    await assert.rejects(future.next(), code(Code.OutOfRange));
    await client.cancelJob({ id: accepted.id });
    await assert.rejects(client.retryJob({ id: accepted.id }), code(Code.FailedPrecondition));
    const cursor = BigInt(coordinator.store.sequence());
    for (let i = 0; i < 205; i++) coordinator.store.event(accepted.id, "progress", `part ${String(i)}`);
    const page = await client.listEvents({ afterSequence: cursor, jobId: accepted.id });
    assert.equal(page.events.length, 200);
    const next = await client.listEvents({ afterSequence: present(page.events.at(-1)).sequence, jobId: accepted.id });
    assert.equal(next.events.length, 5);
    assert.equal(present(next.events.at(-1)).sequence, BigInt(coordinator.store.sequence()));
    await coordinator.close();
    const replacement = await createApplicationFixture(directory);
    try {
      await replacement.start();
      const resumed = present((await schedulerClient(directory).getSnapshot({})).snapshot);
      assert.equal(resumed.instanceId, before.instanceId);
      assert.equal(resumed.sequence, present(next.events.at(-1)).sequence);
    } finally {
      await replacement.close();
    }
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
