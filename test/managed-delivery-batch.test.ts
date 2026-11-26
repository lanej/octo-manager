import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { TrackingService, type TrackingOptions } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { DigestService } from "../src/notifications/service.js";
import { DigestState } from "../src/notifications/types.js";
import { actionNotice } from "../src/security/notifications.js";
import type { AgentTarget } from "../src/tracking/types.js";
import type { AgentConnection } from "../src/agents/codex.js";

async function fixture(targets: AgentTarget[], recorded = true) {
  const directory = await mkdtemp(join(tmpdir(), "octo-managed-batch-"));
  const store = new Store(directory, () => 1000);
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  const prepared: string[] = [];
  const connection: AgentConnection = {
    prepare: (agent) => {
      prepared.push(agent.id);
      return Promise.resolve({ busy: true });
    },
    find: () => Promise.resolve({ found: false }),
    send: () => Promise.reject(new Error("Unexpected send")),
    close() {},
  };
  const options: TrackingOptions = {
    read: () => Promise.reject(new Error("Controlled unavailable read")),
    connect: () => connection,
    managedQueue: (id) => digests.managed(id),
    managedQueueBatch: (ids) => digests.managedBatch(ids),
  };
  let tracking = new TrackingService(store.tracking, config, () => 1000, options);
  const digests = new DigestService(store.digests, tracking, store.submissions, directory);
  const prs = targets.map((target, index) => {
    const url = `https://github.com/owner/repo/pull/${String(index + 1)}`;
    const pr = store.tracking.track(url, target);
    store.tracking.observe(
      pr.id,
      {
        observedAt: 1000,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        lifecycle: "open",
        mergeability: "conflicting",
        checks: { state: "complete", value: [] },
        reviews: { state: "complete", value: [] },
      },
      config,
    );
    return pr;
  });
  if (recorded) {
    for (const delivery of store.tracking.deliveries()) {
      const action = store.tracking.action(delivery.actionId);
      const pr = prs.find((value) => value.id === action.prId);
      if (pr === undefined) throw new Error("Missing PR");
      const notice = actionNotice(action, pr.url);
      store.tracking.inbox.freezeNotice(delivery.id, notice);
      store.tracking.inbox.record(delivery.id, store.tracking.inbox.render(delivery.id, notice));
    }
  }
  return {
    store,
    config,
    digests,
    options,
    prs,
    prepared,
    ownerId(index: number): string {
      const pr = prs[index];
      if (pr === undefined) throw new Error("Missing fixture PR");
      return pr.ownerAgentId;
    },
    async pass() {
      tracking.tick();
      await tracking.close();
      tracking = new TrackingService(store.tracking, config, () => 1000, options);
    },
    async close() {
      await tracking.close();
      await digests.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const owner = (sessionId: string, harness = "codex"): AgentTarget => ({
  harness,
  endpoint: "local",
  sessionId,
});

test("default batch resolves duplicate recorded recipients once per pass and refreshes later facts", async () => {
  const f = await fixture([owner("one"), owner("one"), owner("two"), owner("two")]);
  const agent = spyOn(f.store.tracking, "agent");
  try {
    await f.pass();
    expect(agent).toHaveBeenCalledTimes(2);
    expect(f.prepared).toHaveLength(0);
    agent.mockClear();
    f.config.endpoints["local"] = { delivery: "turn", socket: "/synthetic" };
    await f.pass();
    expect(f.prepared).toEqual([f.ownerId(0)]);
    expect(agent.mock.calls.length).toBeGreaterThan(2);
  } finally {
    agent.mockRestore();
    await f.close();
  }
});

test("custom mutable callbacks without a batch hook retain per-row checks", async () => {
  const f = await fixture([owner("one"), owner("two")]);
  let calls = 0;
  delete f.options.managedQueueBatch;
  f.options.managedQueue = () => ++calls === 1;
  try {
    await f.pass();
    expect(calls).toBe(4);
    expect(f.prepared).toEqual([f.ownerId(1)]);
  } finally {
    await f.close();
  }
});

test("custom callback errors without batch support retain the original delivery failure path", async () => {
  const f = await fixture([owner("one")]);
  let calls = 0;
  delete f.options.managedQueueBatch;
  f.options.managedQueue = () => {
    calls++;
    throw new Error("Custom classification unavailable");
  };
  try {
    await f.pass();
    expect(calls).toBe(1);
    expect(f.prepared).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("nonrecorded candidates retain direct selection even with a positive batch result", async () => {
  const f = await fixture([owner("one")], false);
  const seen: string[][] = [];
  f.options.managedQueue = () => false;
  f.options.managedQueueBatch = (ids) => {
    seen.push([...ids]);
    return new Set(f.prs.map((pr) => pr.ownerAgentId));
  };
  try {
    await f.pass();
    expect(seen).toEqual([[]]);
    expect(f.prepared).toEqual([f.ownerId(0)]);
    expect(f.store.tracking.deliveryCandidates()[0]?.messageRecorded).toBe(true);
  } finally {
    await f.close();
  }
});

test("Pi recipients retain their pull-inbox fallback when absent from the default managed batch", async () => {
  const f = await fixture([owner("00000000-0000-0000-0000-000000000001", "pi")]);
  try {
    expect(f.digests.managedBatch([f.ownerId(0)])).toEqual(new Set<string>());
    await f.pass();
    expect(f.prepared).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("pending digest cleanup remains managed after an endpoint switches to direct delivery", async () => {
  const f = await fixture([owner("one")]);
  try {
    const pr = f.prs[0],
      delivery = f.store.tracking.deliveries()[0];
    if (pr === undefined || delivery === undefined) throw new Error("Missing fixture");
    const digest = f.store.digests.create(pr.ownerAgentId, { kind: "codex_queue", socket: "/synthetic" }, () => ({
      body: "Immutable fixture notice",
      messageIds: [delivery.id],
    }));
    f.store.digests.save({ ...digest, state: DigestState.Cancelled, cleanupPending: true }, "fixture_cancelled");
    f.config.endpoints["local"] = { delivery: "turn", socket: "/synthetic" };
    await f.pass();
    expect(f.prepared).toHaveLength(0);
    f.store.digests.save(
      { ...digest, state: DigestState.Cancelled, cleanupPending: false },
      "fixture_cleanup_confirmed",
    );
    await f.pass();
    expect(f.prepared).toEqual([pr.ownerAgentId]);
  } finally {
    await f.close();
  }
});

test("a later classification error cannot starve an earlier direct recipient", async () => {
  const f = await fixture([owner("first"), owner("broken")]);
  const direct = f.ownerId(0),
    broken = f.ownerId(1);
  f.config.endpoints["local"] = { delivery: "turn", socket: "/synthetic" };
  const original = f.store.tracking.agent.bind(f.store.tracking);
  const classify = spyOn(f.store.tracking, "agent").mockImplementation((id) => {
    if (id === broken) throw new Error("Later recipient unavailable");
    return original(id);
  });
  try {
    await f.pass();
    expect(f.prepared).toEqual([direct]);
    expect(classify.mock.calls.some(([id]) => id === broken)).toBe(true);
  } finally {
    classify.mockRestore();
    await f.close();
  }
});
