import { rejects } from "node:assert/strict";
import { GitHubReads, GitHubRateLimitError } from "../src/github-api.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Store } from "../src/store.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import { TrackingState, ArchiveReason } from "../src/tracking/retirement.js";
import { CheckWatchState } from "../src/tracking/checks.js";
import { NotificationService } from "../src/tracking/notifications.js";
import {
  githubNotificationReader,
  parseNotificationResponse,
  notificationAccessError,
  type NotificationPage,
  type NotificationReader,
} from "../src/tracking/notification-reader.js";
import type { ObservationInput } from "../src/tracking/types.js";
const owner = { harness: "codex", endpoint: "local", sessionId: "owner" };
const url = "https://github.com/owner/repo/pull/1";
function observation(
  at: number,
  lifecycle: "open" | "closed" = "open",
  status = "completed",
): ObservationInput {
  return {
    observedAt: at,
    headSha: "a".repeat(40),
    baseSha: "base",
    lifecycle,
    mergeability: "mergeable",
    checks: {
      state: "complete",
      value: [
        {
          id: "run1",
          key: "ci",
          name: "CI",
          headSha: "a".repeat(40),
          status,
          conclusion: status === "completed" ? "failure" : "",
          at,
          url: "https://github.com/owner/repo/actions/runs/123",
        },
      ],
    },
    workflows: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
}
async function fixture() {
  const directory = await mkdtemp("/tmp/om-retire-");
  let now = 1000;
  const config = defaultTrackingConfig();
  let store = new Store(directory, () => now);
  return {
    directory,
    config,
    get store() {
      return store;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    reopen() {
      store.close();
      store = new Store(directory, () => now);
    },
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("closed PR drains, archives after a final refresh and retains unread final failure", async () => {
  const f = await fixture();
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "open", "in_progress"),
      f.config,
    );
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Draining);
    const delivery = f.store.tracking.deliveries().at(-1);
    if (delivery === undefined) throw new Error("No final failure");
    f.store.tracking.inbox.record(delivery.id, "Final CI failure");
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
    expect(f.store.tracking.pr(pr.id).archiveReason).toBe(
      ArchiveReason.Settled,
    );
    expect(f.store.tracking.inbox.get(delivery.id)?.applicable).toBe(true);
    f.reopen();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
    expect(
      f.store.tracking.inbox.get(delivery.id)?.acknowledgedAt,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("deadline survives restart, expires unresolved watches, and fences an old read", async () => {
  const f = await fixture();
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "open", "in_progress"),
      f.config,
    );
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "closed", "in_progress"),
      f.config,
    );
    const before = f.store.tracking.pr(pr.id);
    f.advance(1000);
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "closed", "in_progress"),
      f.config,
    );
    expect(f.store.tracking.pr(pr.id).drainDeadlineAt).toBe(
      before.drainDeadlineAt,
    );
    f.reopen();
    f.advance(86400000);
    f.store.tracking.retirement.expire();
    expect(f.store.tracking.pr(pr.id).archiveReason).toBe(
      ArchiveReason.Deadline,
    );
    expect(f.store.tracking.checks.list(pr.id)[0]?.state).toBe(
      CheckWatchState.Expired,
    );
    f.store.tracking.observe(
      pr.id,
      observation(f.now),
      f.config,
      before.trackingEpoch,
    );
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
    f.store.tracking.observe(pr.id, observation(f.now), f.config);
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Watching);
    expect(f.store.tracking.checks.list(pr.id).at(-1)?.generation).toBe(2);
  } finally {
    await f.close();
  }
});
test("notification cursor and queued refresh survive restart without reenrolling unknown or disabled PRs", async () => {
  const f = await fixture();
  let service: NotificationService | undefined,
    tracking: TrackingService | undefined;
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    const page: NotificationPage = {
      updates: [
        { id: "1", updatedAt: 1000, prUrl: url },
        {
          id: "2",
          updatedAt: 1000,
          prUrl: "https://github.com/owner/repo/pull/999",
        },
      ],
      more: true,
      notModified: false,
      pollSeconds: 60,
      serverTime: 1000,
      lastModified: "date",
    };
    f.store.notifications.page("github.com/owner", page);
    expect(f.store.notifications.cursor("github.com/owner").page).toBe(2);
    f.reopen();
    expect(f.store.notifications.pending()).toHaveLength(1);
    let reads = 0;
    tracking = new TrackingService(f.store.tracking, f.config, () => f.now, {
      read: () => {
        reads++;
        return Promise.resolve(observation(f.now));
      },
    });
    const reader: NotificationReader = {
      identity: () => Promise.resolve("github.com/owner"),
      page: () => Promise.resolve({ ...page, updates: [], more: false }),
    };
    service = new NotificationService(
      f.store.notifications,
      tracking,
      () => f.now,
      reader,
    );
    await service.flush();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Watching);
    expect(f.store.tracking.pr(pr.id).ownerAgentId).toBe(pr.ownerAgentId);
    expect(f.store.tracking.prs()).toHaveLength(1);
    expect(reads).toBe(1);
    f.store.tracking.untrack(pr.id);
    f.store.notifications.page("github.com/owner", { ...page, more: false });
    await service.flush();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Disabled);
    expect(reads).toBe(1);
  } finally {
    await service?.close();
    await tracking?.close();
    await f.close();
  }
});
test("notifications retain cursor on failure, honor conditional reads and reject untrusted subjects", () => {
  const parsed = parseNotificationResponse(
    "HTTP/2.0 200 OK\r\nX-Poll-Interval: 120\r\nLast-Modified: stamp\r\n\r\n" +
      JSON.stringify([
        {
          id: "1",
          updated_at: "2026-01-01T00:00:00Z",
          subject: {
            type: "PullRequest",
            url: "https://evil.example/repos/owner/repo/pulls/1",
          },
        },
      ]),
  );
  expect(parsed.pollSeconds).toBe(120);
  expect(parsed.updates[0]?.prUrl).toBeUndefined();
  expect(
    parseNotificationResponse(
      "HTTP/2.0 304 Not Modified\nX-Poll-Interval: 60\n\n",
    ).notModified,
  ).toBe(true);
  expect(() => parseNotificationResponse("HTTP/2.0 200 OK\n\n{}")).toThrow();
});
test("failed notification pagination resumes its cursor, deduplicates updates and respects rate backoff", async () => {
  const f = await fixture();
  let service: NotificationService | undefined,
    tracking: TrackingService | undefined;
  try {
    const pr = f.store.tracking.track(url, owner);
    for (let i = 0; i < 2; i++)
      f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    let fail = true;
    const pages: number[] = [];
    tracking = new TrackingService(f.store.tracking, f.config, () => f.now, {
      read: () =>
        fail
          ? Promise.reject(new Error("PR metadata offline"))
          : Promise.resolve(observation(f.now, "closed")),
    });
    const reader: NotificationReader = {
      identity: () => Promise.resolve("github.com/owner"),
      page: (query) => {
        pages.push(query.page);
        if (query.page === 2 && fail)
          return Promise.reject(new Error("Page unavailable"));
        return Promise.resolve({
          updates: [{ id: "thread", updatedAt: 1000, prUrl: url }],
          more: query.page === 1,
          notModified: false,
          pollSeconds: 120,
          lastModified: "stamp",
          serverTime: 1000,
        });
      },
    };
    service = new NotificationService(
      f.store.notifications,
      tracking,
      () => f.now,
      reader,
    );
    await service.flush();
    expect(f.store.notifications.cursor("github.com/owner").page).toBe(2);
    expect(f.store.notifications.pending()).toHaveLength(0);
    expect(f.store.notifications.status().lastError).toBeDefined();
    f.advance(61000);
    fail = false;
    await service.flush();
    expect(pages).toEqual([1, 2, 2]);
    expect(f.store.notifications.cursor("github.com/owner").page).toBe(1);
    expect(f.store.notifications.cursor("github.com/owner").lastModified).toBe(
      "stamp",
    );
    expect(f.store.notifications.status().nextPollAt).toBe(f.now + 120000);
    expect(f.store.notifications.status().lastError).toBeUndefined();
    f.store.notifications.page("github.com/owner", {
      updates: [{ id: "thread", updatedAt: 1000, prUrl: url }],
      more: false,
      notModified: false,
      pollSeconds: 60,
    });
    expect(f.store.notifications.pending()).toHaveLength(0);
  } finally {
    await service?.close();
    await tracking?.close();
    await f.close();
  }
});
test("manual disable and retrack fence an already running observation", async () => {
  const f = await fixture();
  let tracking: TrackingService | undefined;
  try {
    const pr = f.store.tracking.track(url, owner);
    let resolve: ((value: ObservationInput) => void) | undefined;
    let calls = 0;
    tracking = new TrackingService(f.store.tracking, f.config, () => f.now, {
      read: () => {
        calls++;
        return calls === 1
          ? new Promise<ObservationInput>((done) => {
              resolve = done;
            })
          : Promise.resolve({ ...observation(f.now), headSha: "new-head" });
      },
    });
    const first = tracking.refresh(pr.id);
    f.store.tracking.untrack(pr.id);
    f.store.tracking.track(url, owner);
    const second = tracking.refresh(pr.id);
    if (resolve === undefined) throw new Error("Read did not begin");
    resolve(observation(f.now, "closed"));
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Watching);
    expect(f.store.tracking.pr(pr.id).observation?.headSha).toBe("new-head");
  } finally {
    await tracking?.close();
    await f.close();
  }
});

test("notification access failures retain server retry deadlines", () => {
  const response =
    "HTTP/2 403 Forbidden\r\nDate: Thu, 12 Nov 2026 00:00:00 GMT\r\nRetry-After: 120\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1794441900\r\n\r\n{}";
  expect(notificationAccessError(response).retryAt).toBe(
    Math.max(Date.parse("2026-11-12T00:02:00Z"), 1794441901000),
  );
  expect(
    notificationAccessError("HTTP/2 401 Unauthorized\r\n\r\n{}").retryAt,
  ).toBeUndefined();
});

test("retirement deadlines expire locally during a shared GitHub cooldown without resuming archived polling", async () => {
  const f = await fixture();
  let reads = 0;
  const retryAt = f.now + 2 * 86400000;
  const service = new TrackingService(f.store.tracking, f.config, () => f.now, {
    read: () => {
      reads++;
      return reads === 1
        ? Promise.reject(new GitHubRateLimitError(retryAt))
        : Promise.resolve(observation(f.now, "closed"));
    },
  });
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "open", "in_progress"),
      f.config,
    );
    f.store.tracking.observe(
      pr.id,
      observation(f.now, "closed", "in_progress"),
      f.config,
    );
    await service.refresh(pr.id);
    expect(reads).toBe(1);
    f.advance(86400001);
    service.tick();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
    expect(f.store.tracking.checks.list(pr.id)[0]?.state).toBe(
      CheckWatchState.Expired,
    );
    await rejects(service.refresh(pr.id), GitHubRateLimitError);
    expect(reads).toBe(1);
    f.advance(86400000);
    service.tick();
    expect(reads).toBe(1);
    await service.refresh(pr.id);
    expect(reads).toBe(2);
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
  } finally {
    await service.close();
    await f.close();
  }
});
test("startup archives cached settled merged PRs without fetching or removing history", async () => {
  const f = await fixture();
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(pr.id, observation(f.now), f.config);
    f.store.tracking.observe(
      pr.id,
      { ...observation(f.now), lifecycle: "merged" },
      f.config,
    );
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Draining);
    f.reopen();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
    expect(f.store.tracking.prs().length).toBe(1);
    expect(f.store.tracking.actions().length).toBeGreaterThan(0);
    f.reopen();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Archived);
  } finally {
    await f.close();
  }
});
test("startup retains draining PRs whose cached checks are still running", async () => {
  const f = await fixture();
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(
      pr.id,
      { ...observation(f.now, "open", "in_progress"), lifecycle: "merged" },
      f.config,
    );
    f.reopen();
    expect(f.store.tracking.pr(pr.id).state).toBe(TrackingState.Draining);
  } finally {
    await f.close();
  }
});

test("SDK notification cooldown survives coordinator restart", async () => {
  const f = await fixture();
  let tracking: TrackingService | undefined;
  let service: NotificationService | undefined;
  let calls = 0;
  const reader = () =>
    githubNotificationReader(
      new GitHubReads(
        (request) => {
          calls++;
          return Promise.resolve(
            request.path === "user"
              ? {
                  status: 200,
                  headers: new Map<string, string>(),
                  body: '{"login":"owner"}',
                }
              : {
                  status: 429,
                  headers: new Map([["retry-after", "180"]]),
                  body: '{"message":"rate limit"}',
                },
          );
        },
        () => f.now,
      ),
    );
  try {
    const pr = f.store.tracking.track(url, owner);
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    f.store.tracking.observe(pr.id, observation(f.now, "closed"), f.config);
    tracking = new TrackingService(f.store.tracking, f.config, () => f.now);
    service = new NotificationService(
      f.store.notifications,
      tracking,
      () => f.now,
      reader(),
    );
    await service.flush();
    expect(f.store.notifications.status().nextPollAt).toBe(f.now + 180000);
    await service.close();
    await tracking.close();
    f.reopen();
    f.advance(61000);
    tracking = new TrackingService(f.store.tracking, f.config, () => f.now);
    service = new NotificationService(
      f.store.notifications,
      tracking,
      () => f.now,
      reader(),
    );
    await service.flush();
    expect(calls).toBe(2);
  } finally {
    await service?.close();
    await tracking?.close();
    await f.close();
  }
});
