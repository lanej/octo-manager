import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../src/coordinator.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const workerPath = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));

test("idle coordinator does not repeatedly read the jobs table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-idle-jobs-"));
  const coordinator = new Coordinator(directory, { workerPath });
  try {
    await coordinator.start();
    const reads = spyOn(coordinator.store, "jobs");
    try {
      await sleep(350);
      expect(reads).not.toHaveBeenCalled();
      coordinator.inputsChanged();
      await sleep(30);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("job writes and resume wake dispatch, with retry availability scheduled at its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-due-jobs-"));
  const coordinator = new Coordinator(directory, { workerPath });
  try {
    await coordinator.start();
    coordinator.store.setPaused(true);
    const job = coordinator.store.submit({ kind: "resolve_conflict" }, "due");
    const availableAt = Date.now() + 150;
    coordinator.store.save(
      { ...job, status: "retry_wait", availableAt },
      "fixture",
    );
    coordinator.store.setPaused(false);
    await sleep(60);
    expect(coordinator.store.get(job.id).attempts).toHaveLength(0);
    const end = Date.now() + 3000;
    while (
      coordinator.store.get(job.id).status !== "succeeded" &&
      Date.now() < end
    )
      await sleep(20);
    const result = coordinator.store.get(job.id);
    expect(result.status).toBe("succeeded");
    expect(result.attempts[0]?.startedAt).toBeGreaterThanOrEqual(availableAt);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository reconciliation sleeps without configured files and wakes on input intake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-idle-policy-"));
  const coordinator = new Coordinator(directory, { workerPath });
  try {
    await coordinator.start();
    const reads = spyOn(coordinator.store.repositories, "tick");
    try {
      await sleep(1100);
      expect(reads).not.toHaveBeenCalled();
      coordinator.inputsChanged();
      await sleep(20);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
