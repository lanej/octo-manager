import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Coordinator } from "../src/coordinator.js";
import type { MergeOptions } from "../src/merging/service.js";
import type { ObservationInput } from "../src/tracking/types.js";

const observation: ObservationInput = {
  observedAt: 1000,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  lifecycle: "open",
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
  feedback: { state: "complete", value: [] },
  description: "",
};

function activeReferences(coordinator: Coordinator, prId: string) {
  return coordinator.store.merging
    .refs(prId)
    .filter((ref) => ref.active)
    .map((ref) => ({ targetUrl: ref.targetUrl, targetKind: ref.targetKind }));
}

async function fixture(mergeOptions: MergeOptions = {}) {
  const directory = await mkdtemp("/tmp/octo-reference-scope-");
  const coordinator = new Coordinator(directory, { mergeOptions });
  const prs = [1, 2, 3].map((number) => {
    const pr = coordinator.store.tracking.track(
      `https://github.com/owner/repo/pull/${String(number)}`,
      { harness: "codex", endpoint: "local", sessionId: "reference-scope" },
    );
    coordinator.store.tracking.observe(
      pr.id,
      observation,
      coordinator.tracking.config,
    );
    return pr;
  });
  await coordinator.merging.tick();
  return {
    coordinator,
    prs,
    async close() {
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("one provider observation rescans only its PR and retains broad invalidation", async () => {
  const f = await fixture();
  const reads = spyOn(f.coordinator.store.tracking, "referenceObservation");
  const roster = spyOn(f.coordinator.store.tracking, "prContexts");
  try {
    const pr = f.prs[0];
    if (pr === undefined) throw new Error("Missing fixture PR");
    f.coordinator.store.tracking.observe(
      pr.id,
      { ...observation, observedAt: 2000, description: "Depends on #2" },
      f.coordinator.tracking.config,
    );
    await f.coordinator.merging.tick();
    await f.coordinator.merging.tick();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(reads.mock.calls.every(([id]) => id === pr.id)).toBe(true);
    expect(activeReferences(f.coordinator, pr.id)).toContainEqual({
      targetUrl: "https://github.com/owner/repo/pull/2",
      targetKind: "pr",
    });
    reads.mockClear();
    roster.mockClear();
    await f.coordinator.merging.tick();
    expect(reads).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    f.coordinator.inputsChanged();
    await f.coordinator.merging.tick();
    expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(
      f.prs.map((value) => value.id).sort(),
    );
  } finally {
    reads.mockRestore();
    roster.mockRestore();
    await f.close();
  }
});

test("a PR invalidated after its position in an active scan is visited on the next pass", async () => {
  const f = await fixture();
  const first = f.prs[0],
    second = f.prs[1];
  if (first === undefined || second === undefined)
    throw new Error("Missing fixture PRs");
  const original = f.coordinator.store.tracking.referenceObservation.bind(
    f.coordinator.store.tracking,
  );
  let changed = false;
  const reads = spyOn(
    f.coordinator.store.tracking,
    "referenceObservation",
  ).mockImplementation((id) => {
    if (id === second.id && !changed) {
      changed = true;
      f.coordinator.store.tracking.observe(
        first.id,
        { ...observation, observedAt: 2000, description: "Depends on #3" },
        f.coordinator.tracking.config,
      );
    }
    return original(id);
  });
  try {
    f.coordinator.inputsChanged({ prId: second.id });
    await f.coordinator.merging.tick();
    expect(reads.mock.calls.map(([id]) => id)).toEqual([second.id]);
    await f.coordinator.merging.tick();
    expect(reads.mock.calls.map(([id]) => id)).toEqual([second.id, first.id]);
    expect(activeReferences(f.coordinator, first.id)).toContainEqual({
      targetUrl: "https://github.com/owner/repo/pull/3",
      targetKind: "pr",
    });
  } finally {
    reads.mockRestore();
    await f.close();
  }
});

test("existing roster-wide reference revision callbacks still invalidate every PR", async () => {
  let revision = "one";
  const f = await fixture({ referenceInputRevision: () => revision });
  const reads = spyOn(f.coordinator.store.tracking, "referenceObservation");
  try {
    await f.coordinator.merging.tick();
    expect(reads).not.toHaveBeenCalled();
    revision = "two";
    await f.coordinator.merging.tick();
    expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(
      f.prs.map((pr) => pr.id).sort(),
    );
  } finally {
    reads.mockRestore();
    await f.close();
  }
});

test("internal enrollment and retracking invalidate the reference roster without API intake", async () => {
  const f = await fixture();
  try {
    const first = f.prs[0];
    if (first === undefined) throw new Error("Missing fixture PR");
    f.coordinator.store.tracking.observe(
      first.id,
      { ...observation, description: "Depends on #4" },
      f.coordinator.tracking.config,
    );
    await f.coordinator.merging.tick();
    expect(
      activeReferences(f.coordinator, first.id).map((ref) => ref.targetKind),
    ).toContain("issue_or_pr");
    const fourth = f.coordinator.tracking.track(
      "https://github.com/owner/repo/pull/4",
      { harness: "codex", endpoint: "local", sessionId: "reference-scope" },
    );
    f.coordinator.store.tracking.observe(
      fourth.id,
      { ...observation, description: "Depends on #1" },
      f.coordinator.tracking.config,
    );
    await f.coordinator.merging.tick();
    expect(activeReferences(f.coordinator, first.id)).toContainEqual({
      targetKind: "pr",
      targetUrl: fourth.url,
    });
    expect(activeReferences(f.coordinator, fourth.id)).toContainEqual({
      targetUrl: first.url,
      targetKind: "pr",
    });
    f.coordinator.store.tracking.untrack(fourth.id);
    await f.coordinator.merging.tick();
    const reads = spyOn(f.coordinator.store.tracking, "referenceObservation");
    try {
      f.coordinator.tracking.track(fourth.url, {
        harness: "codex",
        endpoint: "local",
        sessionId: "reference-scope",
      });
      await f.coordinator.merging.tick();
      expect(reads.mock.calls.map(([id]) => id)).toContain(fourth.id);
    } finally {
      reads.mockRestore();
    }
  } finally {
    await f.close();
  }
});
