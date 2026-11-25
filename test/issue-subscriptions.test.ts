import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { IssueService, type IssueOptions } from "../src/issues/service.js";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import {
  IssueNotificationKind as Kind,
  IssueStage,
  Waiting,
  type IssueRecord,
  type TrackerObservation,
} from "../src/issues/contracts.js";
import { IssueNotificationEventKind as WireKind } from "../src/gen/octomanager/v2/issues_pb.js";
import { inspectMessage } from "../src/notifications/inspection.js";
import { renderDigest } from "../src/notifications/render.js";

function issue(ownerId: string): IssueRecord {
  return {
    id: "issue",
    ref: {
      provider: "test",
      project: "owner/project",
      externalId: "1",
      url: "https://github.com/owner/project/issues/1",
    },
    root: process.cwd(),
    ownerId,
    title: "Title",
    body: "Description",
    stage: IssueStage.Ready,
    waiting: Waiting.Paused,
    detail: "Explicitly paused",
    epoch: 1,
    brief: undefined,
    approvedVersion: 0,
    publicationVersion: 0,
    policyHash: "test",
    externalClosed: false,
    comments: [],
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
    createdAt: 1,
    updatedAt: 1,
    nextAt: Date.now() + 3600000,
    pollIntervalMs: 900000,
  };
}
function observation(revision = "1"): TrackerObservation {
  return {
    title: "Title",
    body: "Description",
    closed: false,
    comments: [],
    complete: true,
    revision,
  };
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "octo-issue-subscriptions-"));
  const store = new Store(directory);
  const owner = store.tracking.registerAgent({
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  const observer = store.tracking.registerAgent({
    harness: "codex",
    endpoint: "local",
    sessionId: "observer",
  });
  const value = issue(owner.id);
  store.issues.save(value, "enrolled", value.detail);
  return {
    directory,
    store,
    owner,
    observer,
    value,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function rejection(request: Promise<unknown>): Promise<string> {
  try {
    await request;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw new Error("Expected an Error rejection", { cause: error });
  }
  throw new Error("Expected the RPC to reject");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
function inbox(store: Store, agentId: string) {
  return store.tracking.inbox.list(agentId, 0, false, true).messages;
}

test("complete source observations fan out only selected events and retain frozen bounded evidence", () => {
  const f = setup();
  try {
    f.store.issues.subscriptions.set(f.value, f.owner.id, [
      Kind.Title,
      Kind.Description,
      Kind.Comment,
    ]);
    f.store.issues.subscriptions.set(f.value, f.observer.id, [
      Kind.Closed,
      Kind.Reopened,
    ]);
    const first = observation();
    f.store.issues.subscriptions.observe(f.value, first);
    expect(inbox(f.store, f.owner.id)).toHaveLength(0);
    const changed = {
      ...first,
      title: "Edited title",
      body: "Edited body",
      closed: true,
      revision: "UNTRUSTED revision",
      comments: [
        {
          id: "comment-1",
          revision: "r1",
          author: "author",
          body: "UNTRUSTED comment",
          url: "https://github.com/owner/project/issues/1#issuecomment-1",
        },
      ],
    };
    f.store.issues.atomic(() => {
      f.store.issues.subscriptions.observe(f.value, changed);
    });
    expect(
      inbox(f.store, f.owner.id).map((m) => m.notice?.issueEventKind),
    ).toEqual([Kind.Title, Kind.Description, Kind.Comment]);
    expect(
      inbox(f.store, f.observer.id).map((m) => m.notice?.issueEventKind),
    ).toEqual([Kind.Closed]);
    f.store.issues.subscriptions.observe(f.value, changed);
    f.store.issues.save(
      { ...f.value, detail: "Another coordinator state" },
      "paused",
      "Another coordinator state",
    );
    expect(inbox(f.store, f.owner.id)).toHaveLength(3);
    const messages = inbox(f.store, f.owner.id);
    const digest = renderDigest(
      messages,
      f.directory,
      "12345678-1111-1111-1111-111111111111",
    );
    expect(digest.body).not.toContain("UNTRUSTED");
    for (const message of inbox(f.store, f.owner.id))
      expect(message.notice?.issueRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest.body).not.toContain("Edited title");
    const message = messages.find(
      (m) => m.notice?.issueEventKind === Kind.Comment,
    );
    if (message === undefined)
      throw new Error("Selected comment notice missing");
    const before = f.store.issues.get(f.value.id);
    f.store.issues.save(
      { ...before, title: "Later title" },
      "changed",
      "Later title",
    );
    const read = inspectMessage(
      f.store,
      {
        dispatchId: "receipt",
        body: digest.body,
        messageIds: [message.id],
        createdAt: 1,
      },
      f.owner.id,
      true,
      (m) => m.applicable,
    );
    const item = read.items[0];
    expect(item?.source.case).toBe("issue");
    if (item?.source.case !== "issue")
      throw new Error("Missing issue evidence");
    expect(item.source.value.evidence).toMatchObject({
      kind: WireKind.COMMENT,
      commentId: "comment-1",
      commentRevision: "r1",
      after: "UNTRUSTED comment",
    });
    const filtered = inspectMessage(
      f.store,
      {
        dispatchId: "receipt",
        body: digest.body,
        messageIds: [message.id],
        createdAt: 1,
      },
      f.owner.id,
      false,
      (m) => m.applicable,
    );
    expect(
      JSON.stringify(filtered, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("UNTRUSTED");
    f.store.issues.subscriptions.observe(f.value, {
      ...changed,
      closed: false,
      revision: "3",
    });
    expect(
      inbox(f.store, f.observer.id).map((m) => m.notice?.issueEventKind),
    ).toEqual([Kind.Closed, Kind.Reopened]);
    f.store.issues.subscriptions.observe(f.value, {
      ...changed,
      revision: "4",
      comments: [
        {
          ...required(changed.comments[0]),
          revision: "r2",
          body: "Edited comment",
        },
      ],
    });
    expect(
      inbox(f.store, f.owner.id).filter(
        (m) => m.notice?.issueEventKind === Kind.Comment,
      ),
    ).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("legacy defaults, explicit mute and pending mixed selection changes preserve execution and restart state", () => {
  const f = setup();
  let reopened: Store | undefined;
  try {
    expect(f.store.issues.subscriptions.list(f.value)).toMatchObject([
      {
        mode: "legacy",
        events: [Kind.Coordinator, Kind.RefreshFailure, Kind.RefreshRecovery],
      },
    ]);
    f.store.issues.subscriptions.set(f.value, f.owner.id, []);
    f.store.issues.subscriptions.set(f.value, f.observer.id, [
      Kind.Title,
      Kind.Comment,
    ]);
    f.store.issues.subscriptions.observe(f.value, observation());
    const changed = {
      ...observation("2"),
      title: "New",
      comments: [
        {
          id: "c",
          revision: "1",
          author: "a",
          body: "selected",
          url: "https://github.com/owner/project/issues/1#c",
        },
      ],
    };
    f.store.issues.subscriptions.observe(f.value, changed);
    const pending = inbox(f.store, f.observer.id);
    expect(pending).toHaveLength(2);
    const frozen = renderDigest(
      pending,
      f.directory,
      "12345678-1111-1111-1111-111111111111",
    );
    f.store.issues.atomic(() =>
      f.store.issues.subscriptions.set(f.value, f.observer.id, [Kind.Comment]),
    );
    expect(
      inbox(f.store, f.observer.id).map((m) => m.notice?.issueEventKind),
    ).toEqual([Kind.Comment]);
    expect(frozen.messageIds).toHaveLength(2);
    expect(
      f.store.tracking.inbox.get(required(pending[0]).id)?.applicable,
    ).toBe(false);
    expect(inbox(f.store, f.owner.id)).toHaveLength(0);
    expect(f.store.issues.get(f.value.id)).toEqual(f.value);
    f.store.close();
    reopened = new Store(f.directory);
    expect(reopened.issues.subscriptions.list(f.value)).toMatchObject([
      { mode: "selected", events: [] },
      { mode: "selected", events: [Kind.Comment] },
    ]);
    reopened.issues.subscriptions.observe(f.value, changed);
    expect(inbox(reopened, f.observer.id)).toHaveLength(1);
    reopened.issues.subscriptions.set(f.value, f.owner.id, undefined);
    expect(reopened.issues.subscriptions.list(f.value)[0]).toMatchObject({
      mode: "legacy",
      explicit: false,
    });
  } finally {
    reopened?.close();
    f.close();
  }
});

test("incomplete observations and refresh failures cannot advance the content baseline", () => {
  const f = setup();
  try {
    f.store.issues.subscriptions.set(f.value, f.owner.id, Object.values(Kind));
    f.store.issues.subscriptions.observe(f.value, observation());
    f.store.issues.subscriptions.observe(f.value, {
      ...observation("2"),
      title: "Incomplete",
      complete: false,
    });
    f.store.issues.subscriptions.failure(f.value, "Temporary failure");
    f.store.issues.save(
      { ...f.value, waiting: Waiting.Blocked, detail: "Temporary failure" },
      "refresh_failed",
      "Temporary failure",
    );
    f.store.issues.subscriptions.observe(f.value, {
      ...observation("3"),
      title: "Complete",
    });
    expect(
      inbox(f.store, f.owner.id).map((m) => m.notice?.issueEventKind),
    ).toEqual([Kind.RefreshFailure, Kind.Title, Kind.RefreshRecovery]);
    const title = inbox(f.store, f.owner.id).find(
      (m) => m.notice?.issueEventKind === Kind.Title,
    );
    expect(
      f.store.issues.subscriptions.evidence(title?.notice?.issueEventId ?? ""),
    ).toMatchObject({ before: "Title", after: "Complete" });
  } finally {
    f.close();
  }
});

test("generated RPC and native CLI update a paused closed issue without dispatch profiles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-issue-subscription-api-"));
  const coordinator = new Coordinator(directory);
  try {
    await coordinator.start();
    const owner = coordinator.tracking.registerAgent({
      harness: "codex",
      endpoint: "local",
      sessionId: "subscriber",
    });
    const value = { ...issue(owner.id), externalClosed: true };
    coordinator.store.issues.save(value, "closed", "Closed");
    const client = schedulerClient(directory);
    const originalSelection = await client.listIssueSubscriptions({
      issueId: value.id,
    });
    for (const issueId of ["", "  "]) {
      expect(
        await rejection(
          client.setIssueSubscription({
            issueId,
            agentId: owner.id,
            filter: { events: [] },
          }),
        ),
      ).toContain("Issue ID required");
      expect(
        await rejection(client.listIssueSubscriptions({ issueId })),
      ).toContain("Issue ID required");
    }
    expect(await client.listIssueSubscriptions({ issueId: value.id })).toEqual(
      originalSelection,
    );
    const selected = await client.setIssueSubscription({
      issueId: value.id,
      agentId: owner.id,
      filter: { events: [WireKind.TITLE, WireKind.COMMENT] },
    });
    expect(selected.subscriptions[0]).toMatchObject({
      mode: "selected",
      events: [WireKind.TITLE, WireKind.COMMENT],
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "dist/cli.js",
        "issue",
        "subscribe",
        value.id,
        "--agent-id",
        owner.id,
        "--events",
        "none",
        "--state",
        directory,
        "--json",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain('"mode":"selected"');
    expect(
      (await client.listIssueSubscriptions({ issueId: value.id }))
        .subscriptions[0]?.events,
    ).toEqual([]);
    expect(coordinator.store.issues.get(value.id)).toEqual(value);
    await client.setIssueSubscription({ issueId: value.id, agentId: owner.id });
    expect(
      (await client.listIssueSubscriptions({ issueId: value.id }))
        .subscriptions[0]?.mode,
    ).toBe("legacy");
    expect(coordinator.store.issues.assignments(value.id)).toEqual([]);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service observation reconciles queued mixed digests while terminal source monitoring never resumes work", async () => {
  const { defaultTrackingConfig } = await import("../src/tracking/config.js");
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  const directory = mkdtempSync(join(tmpdir(), "octo-source-digest-"));
  const slots = new Map<
    string,
    { queueId: string; clientId: string; body: string }
  >();
  let serial = 0;
  let reads = 0;
  let current = { ...observation(), closed: true };
  let failure = false;
  let failureDetail = "Fixture refresh failed";
  const issueOptions: IssueOptions = {
    trackers: [
      {
        provider: "test",
        identify: () => {
          throw new Error("Unexpected enrollment");
        },
        verifyRepository: () => {
          throw new Error("Unexpected repository change");
        },
        observe: () => {
          reads++;
          return failure
            ? Promise.reject(new Error(failureDetail))
            : Promise.resolve(current);
        },
        post: () => Promise.reject(new Error("Unexpected post")),
        findPost: () => Promise.resolve(undefined),
        createFollowUp: () => Promise.reject(new Error("Unexpected follow-up")),
        findFollowUp: () => Promise.resolve(undefined),
        close: () => Promise.reject(new Error("Unexpected close")),
      },
    ],
    dispatchers: [],
    workspace: {
      allocate: () => Promise.reject(new Error("Unexpected allocation")),
    },
    codeHost: {
      commit: () => Promise.reject(new Error("Unexpected commit")),
      publish: () => Promise.reject(new Error("Unexpected publication")),
      enroll: () => {
        throw new Error("Unexpected PR enrollment");
      },
      inspect: () => undefined,
    },
    policy: () => {
      throw new Error("Terminal subscription must not load dispatch profiles");
    },
  };
  const coordinator = new Coordinator(directory, {
    trackingConfig: config,
    issueOptions,
    digestOptions: {
      intervalMs: 10,
      connect: (agent) => ({
        prepare: () => Promise.resolve({ busy: true }),
        queued: () =>
          Promise.resolve(
            slots.has(agent.id) ? [required(slots.get(agent.id))] : [],
          ),
        enqueueQueued: (_agent, clientId, body) => {
          const item = { queueId: `q-${String(++serial)}`, clientId, body };
          slots.set(agent.id, item);
          return Promise.resolve(item);
        },
        cancelQueued: () => {
          slots.delete(agent.id);
          return Promise.resolve(true);
        },
        received: () => Promise.resolve({ bodies: [], complete: true }),
        close: () => {},
      }),
    },
  });
  const service = coordinator.issues;
  try {
    await coordinator.start();
    const owner = coordinator.tracking.registerAgent({
      harness: "codex",
      endpoint: "local",
      sessionId: "queued-issue-owner",
    });
    const value = {
      ...issue(owner.id),
      stage: IssueStage.Done,
      externalClosed: true,
      nextAt: 0,
    };
    coordinator.store.issues.save(value, "done", "Done");
    await service.tick();
    expect(reads).toBe(0);
    const client = schedulerClient(directory);
    await client.setIssueSubscription({
      issueId: value.id,
      agentId: owner.id,
      filter: { events: [WireKind.TITLE, WireKind.COMMENT] },
    });
    await service.tick();
    expect(reads).toBe(1);
    expect(inbox(coordinator.store, owner.id)).toHaveLength(0);
    const due = () => {
      coordinator.store.issues.save(
        { ...coordinator.store.issues.get(value.id), nextAt: 0 },
        "test_due",
        "Fixture scheduler due",
      );
    };
    current = {
      ...current,
      title: "Edited title",
      closed: true,
      revision: "2",
      comments: [
        {
          id: "selected-comment",
          revision: "1",
          author: "author",
          body: "Private producer text",
          url: "https://github.com/owner/project/issues/1#c",
        },
      ],
    };
    due();
    await service.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      await coordinator.digests.flush();
      if (
        slots.get(owner.id)?.body.includes("Issue title") === true &&
        slots.get(owner.id)?.body.includes("Issue comment") === true
      )
        break;
      await Bun.sleep(10);
    }
    const active = required(coordinator.store.digests.active(owner.id));
    const original = coordinator.store.digests.version(
      active.id,
      active.revision,
    );
    expect(original.messageIds).toHaveLength(2);
    expect(slots.get(owner.id)?.body).not.toContain("Private producer text");
    await client.setIssueSubscription({
      issueId: value.id,
      agentId: owner.id,
      filter: { events: [WireKind.COMMENT] },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      await coordinator.digests.flush();
      if (
        slots.get(owner.id)?.body.includes("Issue title") === false &&
        slots.get(owner.id)?.body.includes("Issue comment") === true
      )
        break;
      await Bun.sleep(10);
    }
    expect(slots.get(owner.id)?.body).not.toContain("Issue title");
    expect(slots.get(owner.id)?.body).toContain("Issue comment");
    expect(
      coordinator.store.digests.version(active.id, active.revision),
    ).toEqual(original);
    expect(coordinator.store.digests.receipts(active.id)).toEqual([]);
    const observed = coordinator.store.issues.get(value.id);
    expect(observed).toMatchObject({
      stage: IssueStage.Done,
      waiting: value.waiting,
      epoch: value.epoch,
      approvedVersion: value.approvedVersion,
      assignmentId: "",
      externalClosed: true,
      title: value.title,
      body: value.body,
      comments: value.comments,
    });
    const count = inbox(coordinator.store, owner.id).length;
    current = {
      ...current,
      title: "Incomplete title",
      complete: false,
      revision: "3",
    };
    due();
    await service.tick();
    expect(inbox(coordinator.store, owner.id)).toHaveLength(count);
    expect(coordinator.store.issues.get(value.id)).toMatchObject({
      stage: IssueStage.Done,
      waiting: value.waiting,
      epoch: value.epoch,
      title: value.title,
    });
    failure = true;
    due();
    await service.tick();
    expect(coordinator.store.issues.get(value.id)).toMatchObject({
      stage: IssueStage.Done,
      waiting: value.waiting,
      epoch: value.epoch,
    });
    expect(coordinator.store.issues.get(value.id).nextAt).toBeGreaterThan(
      Date.now(),
    );
    await client.setIssueSubscription({
      issueId: value.id,
      agentId: owner.id,
      filter: { events: [] },
    });
    due();
    const before = reads;
    await service.tick();
    expect(reads).toBe(before);
    coordinator.store.issues.save(
      {
        ...coordinator.store.issues.get(value.id),
        stage: IssueStage.Cancelled,
        waiting: Waiting.None,
        nextAt: 0,
      },
      "cancelled",
      "Fixture retained cancellation",
    );
    await service.tick();
    expect(reads).toBe(before);
    failure = true;
    failureDetail = "Cancelled fixture refresh failed";
    await client.setIssueSubscription({
      issueId: value.id,
      agentId: owner.id,
      filter: {
        events: [
          WireKind.COMMENT,
          WireKind.REFRESH_FAILURE,
          WireKind.REFRESH_RECOVERY,
        ],
      },
    });
    await service.tick();
    expect(reads).toBe(before + 1);
    expect(
      inbox(coordinator.store, owner.id).map(
        (message) => message.notice?.issueEventKind,
      ),
    ).toContain(Kind.RefreshFailure);
    expect(coordinator.store.issues.get(value.id)).toMatchObject({
      stage: IssueStage.Cancelled,
      waiting: Waiting.None,
      epoch: value.epoch,
      assignmentId: "",
    });
    failure = false;
    current = { ...current, complete: true, revision: "4" };
    due();
    await service.tick();
    expect(
      inbox(coordinator.store, owner.id).map(
        (message) => message.notice?.issueEventKind,
      ),
    ).toContain(Kind.RefreshRecovery);
    expect(coordinator.store.issues.get(value.id)).toMatchObject({
      stage: IssueStage.Cancelled,
      waiting: Waiting.None,
      epoch: value.epoch,
      assignmentId: "",
    });
    expect(coordinator.store.issues.assignments(value.id)).toEqual([]);
  } finally {
    await service.close();
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status deactivation preserves content and muted unchanged saves do not accumulate events", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = setup();
  try {
    f.store.issues.subscriptions.set(f.value, f.observer.id, [Kind.Title]);
    f.store.issues.subscriptions.observe(f.value, observation());
    f.store.issues.subscriptions.observe(f.value, {
      ...observation("2"),
      title: "Selected",
    });
    expect(inbox(f.store, f.owner.id)).toHaveLength(1);
    f.store.issues.save(
      { ...f.value, waiting: Waiting.None },
      "resumed",
      "Resumed",
    );
    expect(inbox(f.store, f.owner.id)).toHaveLength(0);
    expect(inbox(f.store, f.observer.id)).toHaveLength(1);
    f.store.issues.subscriptions.set(f.value, f.owner.id, []);
    f.store.issues.save(
      { ...f.value, detail: "Muted status" },
      "paused",
      "Muted status",
    );
    const db = new DatabaseSync(join(f.directory, "jobs.sqlite"), {
      readOnly: true,
    });
    try {
      const count = () =>
        Number(
          db
            .prepare("SELECT COUNT(*) AS count FROM issue_notification_events")
            .get()?.["count"],
        );
      const before = count();
      for (let i = 0; i < 3; i++)
        f.store.issues.save(
          { ...f.value, detail: "Muted status" },
          "paused",
          "Muted status",
        );
      expect(count()).toBe(before);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test("refresh episodes preserve long-error provenance and do not reclassify an operator pause", async () => {
  const { createHash } = await import("node:crypto");
  const f = setup();
  try {
    f.store.issues.subscriptions.set(f.value, f.observer.id, [
      Kind.Coordinator,
    ]);
    f.store.issues.subscriptions.observe(f.value, observation());
    const detail = "x".repeat(16000) + "last error bytes";
    f.store.issues.subscriptions.failure(f.value, detail);
    const failure = required(
      inbox(f.store, f.owner.id).find(
        (message) => message.notice?.issueEventKind === Kind.RefreshFailure,
      ),
    );
    expect(
      f.store.issues.subscriptions.evidence(failure.notice?.issueEventId ?? ""),
    ).toMatchObject({
      afterTruncated: true,
      afterDigest: createHash("sha256").update(detail).digest("hex"),
    });
    f.store.issues.save(
      { ...f.value, detail: "Paused by operator" },
      "pause",
      "Paused by operator",
    );
    expect(
      inbox(f.store, f.observer.id).map(
        (message) => message.notice?.issueEventKind,
      ),
    ).toEqual([Kind.Coordinator]);
    f.store.issues.subscriptions.observe(f.value, observation("2"));
    const recovery = required(
      inbox(f.store, f.owner.id).find(
        (message) => message.notice?.issueEventKind === Kind.RefreshRecovery,
      ),
    );
    expect(
      f.store.issues.subscriptions.evidence(
        recovery.notice?.issueEventId ?? "",
      ),
    ).toMatchObject({
      beforeTruncated: true,
      beforeDigest: createHash("sha256").update(detail).digest("hex"),
    });
    expect(f.store.tracking.inbox.get(failure.id)?.applicable).toBe(true);
  } finally {
    f.close();
  }
});

test("first unchanged save seeds status identity from a retained legacy notice without redelivery", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash, randomUUID } = await import("node:crypto");
  const { nextInboxSequence } = await import("../src/submissions/schema.js");
  const f = setup();
  try {
    const db = new DatabaseSync(join(f.directory, "jobs.sqlite"));
    try {
      db.exec(
        "DELETE FROM issue_notification_members; DELETE FROM issue_notices; DELETE FROM issue_notification_status",
      );
      const id = randomUUID();
      const revision = createHash("sha256")
        .update(
          JSON.stringify([
            f.value.stage,
            f.value.waiting,
            f.value.brief?.version,
            f.value.detail,
          ]),
        )
        .digest("hex");
      const notice = {
        version: 1 as const,
        kind: "issue" as const,
        assessment: "not_required" as const,
        subject: { kind: "issue" as const, id: f.value.id },
        issueStage: f.value.stage,
        issueWaiting: f.value.waiting,
        issueRevision: revision,
      };
      f.store.notificationRepository.freezeNotice(id, notice);
      db.prepare("INSERT INTO issue_notices VALUES(?,?,?,?,?,?,NULL,?,1)").run(
        nextInboxSequence(db),
        id,
        f.value.id,
        f.owner.id,
        "Retained legacy coordinator notice",
        1,
        1,
      );
      f.store.issues.save({ ...f.value }, "observed", "Unchanged observation");
      expect(inbox(f.store, f.owner.id).map((message) => message.id)).toEqual([
        id,
      ]);
      expect(
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM issue_notices").get()?.[
            "count"
          ],
        ),
      ).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

function observerOptions(
  observe: IssueOptions["trackers"][number]["observe"],
): IssueOptions {
  return {
    trackers: [
      {
        provider: "test",
        identify: () => {
          throw new Error("Unexpected enrollment");
        },
        verifyRepository: () => {},
        observe,
        post: () => Promise.reject(new Error("Unexpected post")),
        findPost: () => Promise.resolve(undefined),
        createFollowUp: () => Promise.reject(new Error("Unexpected follow-up")),
        findFollowUp: () => Promise.resolve(undefined),
        close: () => Promise.reject(new Error("Unexpected close")),
      },
    ],
    dispatchers: [],
    workspace: {
      allocate: () => Promise.reject(new Error("Unexpected allocation")),
    },
    codeHost: {
      commit: () => Promise.reject(new Error("Unexpected commit")),
      publish: () => Promise.reject(new Error("Unexpected publication")),
      enroll: () => {
        throw new Error("Unexpected PR enrollment");
      },
      inspect: () => undefined,
    },
    policy: () => {
      throw new Error("Observer poll must not load dispatch profiles");
    },
  };
}
function controlledPolicy(): ReturnType<IssueOptions["policy"]> {
  const profile = {
    harness: "fake",
    model: "fixture",
    instructions: "",
    timeoutMs: 1000,
  };
  return {
    hash: "test",
    stage: "beta",
    timeoutMs: undefined,
    implement: false,
    publish: false,
    assumptions: false,
    followUps: false,
    profiles: {
      investigation: profile,
      implementation: profile,
      verification: profile,
    },
    concurrency: 1,
  };
}

test("in-flight cancellation or subscription removal cannot restore terminal execution input", async () => {
  for (const outcome of [
    "success",
    "failure",
    "incomplete",
    "unsubscribed",
  ] as const) {
    const f = setup();
    const pending = Promise.withResolvers<TrackerObservation>();
    const started = Promise.withResolvers<undefined>();
    const service = new IssueService(
      f.store.issues,
      observerOptions(() => {
        started.resolve(undefined);
        return pending.promise;
      }),
    );
    try {
      f.store.issues.subscriptions.set(f.value, f.owner.id, [
        Kind.Title,
        Kind.RefreshFailure,
        Kind.RefreshRecovery,
      ]);
      f.store.issues.save({ ...f.value, nextAt: 0 }, "due", "Due");
      const work = service.tick();
      await started.promise;
      service.command(f.value.id, "cancel", "", 0, `cancel-${outcome}`);
      const cancelled = f.store.issues.get(f.value.id);
      if (outcome === "unsubscribed")
        f.store.issues.subscriptions.set(cancelled, f.owner.id, []);
      if (outcome === "failure")
        pending.reject(new Error("Deferred source failure"));
      else
        pending.resolve({
          ...observation("2"),
          title: "Remote edit",
          body: "Remote body",
          complete: outcome !== "incomplete",
        });
      await work;
      const after = f.store.issues.get(f.value.id);
      expect({
        ...after,
        nextAt: cancelled.nextAt,
        updatedAt: cancelled.updatedAt,
      }).toEqual(cancelled);
      expect(f.store.issues.assignments(f.value.id)).toEqual([]);
      if (outcome === "failure" || outcome === "incomplete")
        expect(
          inbox(f.store, f.owner.id).map(
            (message) => message.notice?.issueEventKind,
          ),
        ).toContain(Kind.RefreshFailure);
    } finally {
      await service.close();
      f.close();
    }
  }
});

test("terminal source observation cannot replace accepted body ahead of pending closure reconciliation", async () => {
  const f = setup();
  let closed = 0;
  const options = observerOptions(() =>
    Promise.resolve({
      ...observation("changed"),
      body: "New unaccepted description",
    }),
  );
  options.policy = controlledPolicy;
  const tracker = required(options.trackers[0]);
  tracker.close = () => {
    closed++;
    return Promise.resolve();
  };
  const service = new IssueService(f.store.issues, options);
  try {
    const done = {
      ...f.value,
      stage: IssueStage.Done,
      waiting: Waiting.None,
      nextAt: 0,
    };
    f.store.issues.save(done, "done", "Accepted implementation");
    f.store.issues.subscriptions.set(done, f.owner.id, [Kind.Description]);
    f.store.issues.effect({
      id: "retained-close",
      issueId: done.id,
      kind: "close",
      body: "",
      title: "",
      state: "intended",
      url: "",
    });
    await service.tick();
    expect(closed).toBe(0);
    expect(f.store.issues.get(done.id)).toMatchObject({
      body: done.body,
      stage: IssueStage.Investigation,
      detail: "New input before closure; acceptance must be reassessed",
    });
  } finally {
    await service.close();
    f.close();
  }
});

test("terminal assigned work reconciles before any new subscription source read", async () => {
  const { Role, AttemptState } = await import("../src/issues/contracts.js");
  const f = setup();
  let reads = 0;
  let cancellations = 0;
  const options = observerOptions(() => {
    reads++;
    return Promise.reject(new Error("Source unavailable"));
  });
  options.policy = controlledPolicy;
  options.dispatchers = [
    {
      harness: "fake",
      submit: () => Promise.reject(new Error("Unexpected submit")),
      inspect: () => Promise.reject(new Error("Unexpected inspect")),
      cancel: () => {
        cancellations++;
        return Promise.resolve(true);
      },
    },
  ];
  const service = new IssueService(f.store.issues, options);
  try {
    const value = {
      ...f.value,
      stage: IssueStage.Cancelled,
      waiting: Waiting.None,
      nextAt: 0,
      assignmentId: "retained",
    };
    f.store.issues.assignment({
      id: "retained",
      issueId: value.id,
      role: Role.Investigation,
      purpose: "stage",
      briefVersion: 0,
      epoch: value.epoch,
      state: AttemptState.Running,
      sessionId: "fixture",
      turnId: "turn",
      workspace: "",
      profile: controlledPolicy().profiles.investigation,
      prompt: "",
      result: undefined,
      createdAt: 1,
      updatedAt: 1,
      detail: "Retained assignment",
    });
    f.store.issues.save(value, "cancelled", "Retained cancellation");
    f.store.issues.subscriptions.set(value, f.owner.id, [
      Kind.Comment,
      Kind.RefreshFailure,
    ]);
    await service.tick();
    expect(reads).toBe(0);
    expect(cancellations).toBe(1);
    expect(f.store.issues.get(value.id).assignmentId).toBe("");
    await service.tick();
    expect(reads).toBe(1);
    expect(cancellations).toBe(1);
    expect(f.store.issues.get(value.id)).toMatchObject({
      stage: IssueStage.Cancelled,
      waiting: Waiting.None,
      epoch: value.epoch,
    });
  } finally {
    await service.close();
    f.close();
  }
});

test("service shutdown is not reported as a provider refresh failure", async () => {
  const f = setup();
  const started = Promise.withResolvers<undefined>();
  const service = new IssueService(
    f.store.issues,
    observerOptions(
      (_ref, signal) =>
        new Promise((_resolve, reject) => {
          started.resolve(undefined);
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("Service shutdown"));
            },
            { once: true },
          );
        }),
    ),
  );
  try {
    const done = { ...f.value, stage: IssueStage.Done, nextAt: 0 };
    f.store.issues.save(done, "done", "Done");
    f.store.issues.subscriptions.set(done, f.owner.id, [
      Kind.Comment,
      Kind.RefreshFailure,
    ]);
    const work = service.tick();
    await started.promise;
    await service.close();
    await work;
    expect(inbox(f.store, f.owner.id)).toHaveLength(0);
  } finally {
    await service.close();
    f.close();
  }
});

test("selected source comments include reconciled Octo posts without adding worker input", async () => {
  const f = setup();
  let current = observation();
  const options = observerOptions(() => Promise.resolve(current));
  options.policy = controlledPolicy;
  const service = new IssueService(f.store.issues, options);
  try {
    f.store.issues.save({ ...f.value, nextAt: 0 }, "due", "Due");
    f.store.issues.subscriptions.set(f.value, f.owner.id, [Kind.Comment]);
    await service.tick();
    f.store.issues.effect({
      id: "own-post",
      issueId: f.value.id,
      kind: "post",
      body: "Own update",
      title: "",
      state: "completed",
      url: "https://github.com/owner/project/issues/1#own",
    });
    const ownBody = "Own update\n\n<!-- octo-issue:own-post -->";
    current = {
      ...current,
      revision: "2",
      comments: [
        {
          id: "own",
          revision: "one",
          author: "Octo",
          body: ownBody,
          url: "https://github.com/owner/project/issues/1#own",
        },
      ],
    };
    f.store.issues.save(
      { ...f.store.issues.get(f.value.id), nextAt: 0 },
      "due",
      "Due",
    );
    await service.tick();
    const comment = required(
      inbox(f.store, f.owner.id).find(
        (message) => message.notice?.issueEventKind === Kind.Comment,
      ),
    );
    expect(
      f.store.issues.subscriptions.evidence(comment.notice?.issueEventId ?? ""),
    ).toMatchObject({ commentId: "own", after: ownBody });
    expect(f.store.issues.get(f.value.id)).toMatchObject({
      pendingComments: [],
      comments: [],
      waiting: Waiting.Paused,
    });
    expect(f.store.issues.assignments(f.value.id)).toEqual([]);
  } finally {
    await service.close();
    f.close();
  }
});
