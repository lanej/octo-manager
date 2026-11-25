import { runtimeLifecycle } from "../src/lifecycle-rpc.js";
import { rejects } from "node:assert/strict";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { schedulerClient } from "../src/client.js";
import { Coordinator } from "../src/coordinator.js";

test("API mutations invalidate reconciliation inputs while inspection stays quiet", async () => {
  const directory = await mkdtemp("/tmp/octo-api-intake-");
  const coordinator = new Coordinator(directory, { now: () => 1000 });
  await coordinator.start();
  const client = schedulerClient(directory);
  const changed = spyOn(coordinator, "inputsChanged");
  try {
    await client.getSnapshot({});
    await client.listTrackedPullRequests({});
    await client.listActivity({});
    await runtimeLifecycle(directory, { action: "inventory" });
    expect(changed).not.toHaveBeenCalled();
    const registered = await client.registerAgent({
      target: { harness: "codex", endpoint: "local", sessionId: "api-intake" },
    });
    expect(registered.agent?.id).toBeDefined();
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mockClear();
    await rejects(client.assignPullRequest({ id: "missing" }));
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    changed.mockRestore();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
