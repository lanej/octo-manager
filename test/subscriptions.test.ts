import { ParticipantRole } from "../src/tracking/subscriptions.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Store } from "../src/store.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
} from "../src/tracking/types.js";
const owner = {
  harness: "codex",
  endpoint: "local",
  sessionId: "implementation",
  label: "Octo implementation",
};
const listener = {
  harness: "codex",
  endpoint: "local",
  sessionId: "review",
  label: "Independent review",
};
const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
test("many agents listen across PRs with independent receipts and owner-only action acceptance", async () => {
  const directory = await mkdtemp("/tmp/om-subscriptions-");
  let store = new Store(directory, () => 1000);
  try {
    const first = store.tracking.track(
        "https://github.com/owner/repo/pull/1",
        owner,
      ),
      second = store.tracking.track(
        "https://github.com/owner/other/pull/2",
        owner,
      );
    store.tracking.subscribe(first.id, listener);
    store.tracking.subscribe(second.id, listener);
    const observer = store.tracking
      .agents()
      .find((agent) => agent.sessionId === listener.sessionId);
    if (observer === undefined) throw new Error("Missing observer");
    for (const pr of [first, second])
      store.tracking.observe(pr.id, input, defaultTrackingConfig());
    const deliveries = store.tracking.deliveries();
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries)
      store.tracking.inbox.record(delivery.id, "Frozen update");
    const action = store.tracking
      .actions()
      .find((item) => item.prId === first.id);
    if (action === undefined) throw new Error("Missing action");
    expect(() =>
      store.tracking.progress(action.id, observer.id, false),
    ).toThrow("another agent");
    const ownerCopy = deliveries.find(
        (item) =>
          item.actionId === action.id &&
          item.recipientAgentId === first.ownerAgentId,
      ),
      observerCopy = deliveries.find(
        (item) =>
          item.actionId === action.id && item.recipientAgentId === observer.id,
      );
    if (ownerCopy === undefined || observerCopy === undefined)
      throw new Error("Missing independent copies");
    store.tracking.acknowledgeMessage(ownerCopy.id, first.ownerAgentId);
    expect(
      store.tracking.inbox.get(observerCopy.id)?.acknowledgedAt,
    ).toBeUndefined();
    expect(store.tracking.action(action.id).progress.state).toBe(
      ActionState.Open,
    );
    expect(() =>
      store.tracking.unsubscribe(first.id, first.ownerAgentId),
    ).toThrow("Owner cannot unsubscribe");
    store.tracking.unsubscribe(first.id, observer.id);
    expect(store.tracking.inbox.get(observerCopy.id)?.applicable).toBe(false);
    expect(
      store.tracking.deliveries().find((d) => d.id === observerCopy.id)
        ?.progress.state,
    ).toBe(DeliveryState.Cancelled);
    expect(store.tracking.subscriptions.includes(second.id, observer.id)).toBe(
      true,
    );
    expect(
      store.tracking.inbox
        .list(observer.id, 0, false, true)
        .messages.some(
          (message) =>
            message.actionId !== "" &&
            store.tracking.action(message.actionId).prId === second.id,
        ),
    ).toBe(true);
    store.close();
    store = new Store(directory, () => 2000);
    expect(
      store.tracking.participants(second.id).map((item) => item.label),
    ).toEqual(["Octo implementation", "Independent review"]);
    expect(store.tracking.inbox.get(ownerCopy.id)?.acknowledgedAt).toBe(1000);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("subscription catchup is idempotent, roster changes supersede chatter and leaving cannot revive old unread copies", async () => {
  const directory = await mkdtemp("/tmp/om-subscriptions-");
  const store = new Store(directory, () => 1000);
  try {
    const pr = store.tracking.track(
      "https://github.com/owner/repo/pull/1",
      owner,
    );
    store.tracking.observe(pr.id, input, defaultTrackingConfig());
    store.tracking.subscribe(pr.id, listener);
    const observer = store.tracking
      .agents()
      .find((agent) => agent.sessionId === listener.sessionId);
    if (observer === undefined) throw new Error("Missing observer");
    const copies = store.tracking.deliveries();
    store.tracking.subscribe(pr.id, listener);
    expect(store.tracking.deliveries()).toHaveLength(copies.length);
    const roster = store.tracking.inbox
      .list(observer.id, 0, false, true)
      .messages.find((item) => item.participantPRId === pr.id);
    if (roster === undefined) throw new Error("Missing roster");
    expect(roster.body).toContain("owner: Octo implementation");
    expect(roster.body).toContain("observer: Independent review");
    store.tracking.acknowledgeMessage(roster.id, observer.id);
    const copy = copies.find((item) => item.recipientAgentId === observer.id);
    if (copy === undefined) throw new Error("Missing catchup");
    store.tracking.inbox.record(copy.id, "Original observer copy");
    store.tracking.unsubscribe(pr.id, observer.id);
    store.tracking.subscribe(pr.id, listener);
    expect(store.tracking.inbox.get(copy.id)?.applicable).toBe(false);
    expect(store.tracking.inbox.get(roster.id)?.applicable).toBe(false);
    expect(
      store.tracking.inbox
        .list(observer.id, 0, false, true)
        .messages.filter((item) => item.participantPRId === pr.id),
    ).toHaveLength(1);
    store.tracking.untrack(pr.id);
    expect(() => store.tracking.subscribe(pr.id, listener)).toThrow("disabled");
    expect(
      store.tracking.inbox.list(observer.id, 0, false, true).messages,
    ).toHaveLength(0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner transfer replaces role-specific copies while retaining explicit observers", async () => {
  const directory = await mkdtemp("/tmp/om-subscriptions-");
  const store = new Store(directory, () => 1000);
  try {
    const pr = store.tracking.track(
      "https://github.com/owner/repo/pull/1",
      owner,
    );
    store.tracking.subscribe(pr.id, listener);
    store.tracking.observe(pr.id, input, defaultTrackingConfig());
    const observer = store.tracking
      .agents()
      .find((agent) => agent.sessionId === listener.sessionId);
    if (observer === undefined) throw new Error("Missing observer");
    const old = store.tracking
      .deliveries()
      .find((item) => item.recipientAgentId === observer.id);
    if (old === undefined) throw new Error("Missing observer delivery");
    store.tracking.inbox.record(old.id, "Observer role copy");
    store.tracking.saveDelivery(
      {
        ...old,
        progress: { state: DeliveryState.Delivered, at: 1000 },
        updatedAt: 1000,
      },
      "delivery_delivered",
    );
    store.tracking.assign(pr.id, listener);
    expect(store.tracking.inbox.get(old.id)?.applicable).toBe(false);
    const fresh = store.tracking
      .deliveries()
      .find(
        (item) =>
          item.recipientAgentId === observer.id &&
          item.progress.state === DeliveryState.Pending,
      );
    if (fresh === undefined) throw new Error("No fresh owner copy");
    expect(fresh.id).not.toBe(old.id);
    expect(store.tracking.subscriptions.includes(pr.id, pr.ownerAgentId)).toBe(
      false,
    );
    expect(
      store.tracking.progress(fresh.actionId, observer.id, false).progress
        .state,
    ).toBe(ActionState.Acknowledged);
    store.tracking.assign(pr.id, owner);
    expect(store.tracking.participants(pr.id).map((item) => item.role)).toEqual(
      [ParticipantRole.Owner, ParticipantRole.Observer],
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
