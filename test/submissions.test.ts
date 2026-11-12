import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionService } from "../src/submissions/service.js";
import { SubmissionNotifications } from "../src/submissions/notifications.js";
import {
  SubmissionState as State,
  hash,
  type Role,
  type RepositorySnapshot,
  type SubmissionInput,
} from "../src/submissions/contracts.js";
import type {
  SubmissionGitHub,
  PublishedPR,
} from "../src/submissions/github.js";
import type { RunStage } from "../src/submissions/worker.js";
import type { AgentConnection } from "../src/agents/codex.js";
const owner = {
  harness: "codex" as const,
  endpoint: "local",
  sessionId: "test-caller",
  label: "/test/repo",
};
const request = (id: string): SubmissionInput => ({
  requestId: id,
  repository: "owner/repo",
  headRef: `feature/${id}`,
  headSha: "a".repeat(40),
  baseRef: "main",
  purpose: "Make the example explain its behavior.",
  validation: [
    { command: "check", result: "passed", note: "Caller observed local check" },
  ],
  draft: false,
  owner,
});
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out awaiting submission");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
class GitHub implements SubmissionGitHub {
  revision = "policy-v1";
  private = false;
  writes = 0;
  loseResponse = false;
  beforeVerify: (() => void) | undefined;
  published = new Map<string, PublishedPR>();
  snapshot(input: SubmissionInput): Promise<RepositorySnapshot> {
    return Promise.resolve({
      repository: input.repository,
      headSha: input.headSha,
      baseSha: "b".repeat(40),
      private: this.private,
      files: ["example.md"],
      diff: "+Explain behavior.",
      sources: [
        {
          path: "CONTRIBUTING.md",
          sha: this.revision,
          text: "Include behavior.",
        },
      ],
      sourceDigest: hash(this.revision),
    });
  }
  verify(): Promise<void> {
    this.beforeVerify?.();
    return Promise.resolve();
  }
  find(input: SubmissionInput): Promise<PublishedPR | undefined> {
    return Promise.resolve(this.published.get(input.requestId));
  }
  publish(
    input: SubmissionInput,
    draft: { body: string },
    marker: string,
  ): Promise<PublishedPR> {
    this.writes++;
    const value = {
      url: `https://github.com/owner/repo/pull/${String(this.writes)}`,
      headSha: input.headSha,
      body: draft.body + marker,
      state: "open",
    };
    this.published.set(input.requestId, value);
    return this.loseResponse
      ? Promise.reject(new Error("Connection closed after create"))
      : Promise.resolve(value);
  }
}
function runner(roles: Role[], block = false): RunStage {
  return (role, _input, _schema, instructions, model) => {
    roles.push(role);
    const result: unknown =
      role === "policy"
        ? {
            requirements: [
              {
                id: "behavior",
                strength: "required",
                category: "content",
                description: "Include behavior",
                sourcePath: "CONTRIBUTING.md",
                sourceSha: "policy-v1",
                line: 1,
                quote: "Include behavior.",
                scope: "*",
                check: { kind: "body_contains", value: "behavior" },
              },
            ],
            template: "",
            blockers: [],
          }
        : role === "change"
          ? {
              tier: "routine",
              rationale: "One local documentation change.",
              outcome: "Explains behavior.",
              claims: [
                {
                  statement: "Example describes behavior",
                  falsification:
                    "Read the changed example and find no behavior explanation",
                  evidenceRefs: ["diff"],
                  basis: "observed",
                },
              ],
              limitations: [],
              blockers: [],
            }
          : {
              title: "docs: explain example behavior",
              body: block
                ? "Explains the example."
                : "Explains behavior in the example so readers can follow its purpose.",
              requirementChecks: [],
              blockers: [],
            };
    return Promise.resolve({
      role,
      model,
      promptDigest: hash(instructions),
      raw: JSON.stringify(result),
      result,
      at: Date.now(),
    });
  };
}
async function harness(run: RunStage, github = new GitHub()) {
  const directory = await mkdtemp(join(tmpdir(), "octo-submission-test-"));
  let store = new Store(directory),
    tracking = new TrackingService(
      store.tracking,
      defaultTrackingConfig(),
      Date.now,
      { read: () => Promise.reject(new Error("Offline test")) },
    );
  let service = new SubmissionService(store.submissions, tracking, {
    github,
    run,
    instructions: (role) => Promise.resolve(`Bounded ${role}`),
  });
  service.start();
  return {
    github,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get tracking() {
      return tracking;
    },
    async reopen() {
      await service.close();
      await tracking.close();
      store.close();
      store = new Store(directory);
      tracking = new TrackingService(
        store.tracking,
        defaultTrackingConfig(),
        Date.now,
        { read: () => Promise.reject(new Error("Offline test")) },
      );
      service = new SubmissionService(store.submissions, tracking, {
        github,
        run,
        instructions: (role) => Promise.resolve(`Bounded ${role}`),
      });
      service.start();
    },
    async close() {
      await service.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("publishes once, enrolls, reuses policy, and keeps private submissions supported", async () => {
  const roles: Role[] = [],
    h = await harness(runner(roles));
  try {
    const input = request("first"),
      value = h.service.submit(input);
    expect(h.service.submit(input).id).toBe(value.id);
    await until(
      () => h.store.submissions.get(value.id).state === State.Succeeded,
    );
    expect(h.github.writes).toBe(1);
    expect(roles.sort()).toEqual(["change", "policy", "writer"]);
    const agent = h.store.tracking.agents()[0];
    if (agent === undefined) throw new Error("Missing caller");
    const page = h.store.tracking.inbox.list(agent.id);
    expect(page.messages).toHaveLength(1);
    const notice = page.messages[0];
    if (notice === undefined) throw new Error("Missing notice");
    expect(notice.submissionId).toBe(value.id);
    expect(
      h.store.tracking.acknowledgeMessage(notice.id, agent.id).acknowledgedAt,
    ).toBeDefined();
    h.github.private = true;
    const second = h.service.submit(request("private"));
    await until(
      () => h.store.submissions.get(second.id).state === State.Succeeded,
    );
    expect(roles.filter((role) => role === "policy")).toHaveLength(1);
    expect(h.store.submissions.get(second.id).snapshot?.private).toBe(true);
    await h.reopen();
    expect(h.store.submissions.get(value.id).state).toBe(State.Succeeded);
    expect(h.github.writes).toBe(2);
  } finally {
    await h.close();
  }
});
test("blocks missing repository requirements and preserves falsifiable brief", async () => {
  const h = await harness(runner([], true));
  try {
    const value = h.service.submit(request("blocked"));
    await until(
      () => h.store.submissions.get(value.id).state === State.NeedsInput,
    );
    expect(h.github.writes).toBe(0);
    expect(
      h.store.submissions.get(value.id).brief?.change.claims[0]?.falsification,
    ).toContain("Read");
  } finally {
    await h.close();
  }
});
test("recovers uncertain publication without repeating workers or creating another PR", async () => {
  const roles: Role[] = [],
    h = await harness(runner(roles));
  try {
    h.github.loseResponse = true;
    const value = h.service.submit(request("lost-response"));
    await until(
      () => h.store.submissions.get(value.id).state === State.Uncertain,
    );
    const agent = h.store.tracking.agents()[0];
    if (agent === undefined) throw new Error("No agent");
    const old = h.store.tracking.inbox.list(agent.id).messages[0];
    if (old === undefined) throw new Error("No failure notice");
    h.store.tracking.acknowledgeMessage(old.id, agent.id);
    await h.reopen();
    h.service.retry(value.id);
    await until(
      () => h.store.submissions.get(value.id).state === State.Succeeded,
    );
    expect(h.github.writes).toBe(1);
    expect(roles).toHaveLength(3);
    const messages = h.store.tracking.inbox.list(agent.id, 0, true).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.applicable).toBe(false);
    expect(messages[1]?.body).toContain("tracking active");
  } finally {
    await h.close();
  }
});
test("recovers a terminal callback gap exactly once after restart", async () => {
  const h = await harness(runner([]));
  try {
    const value = h.service.submit(request("callback-gap"));
    await until(
      () => h.store.submissions.get(value.id).state === State.Succeeded,
    );
    h.store.submissions.invalidateNotices(value.id);
    const completed = h.store.submissions.get(value.id);
    h.store.submissions.save({ ...completed, notificationRevision: 0 });
    await h.reopen();
    const agent = h.store.tracking.agents()[0];
    if (agent === undefined) throw new Error("No agent");
    expect(
      h.store.tracking.inbox.list(agent.id, 0, false, true).messages,
    ).toHaveLength(1);
    await h.reopen();
    expect(
      h.store.tracking.inbox.list(agent.id, 0, false, true).messages,
    ).toHaveLength(1);
    expect(h.github.writes).toBe(1);
  } finally {
    await h.close();
  }
});
test("notification defers a busy owner then replays an absent accepted message with stable identity", async () => {
  const h = await harness(runner([]));
  let delivery: SubmissionNotifications | undefined;
  try {
    const value = h.service.submit(request("delivery"));
    await until(
      () => h.store.submissions.get(value.id).state === State.Succeeded,
    );
    let busy = true;
    const sent: string[] = [];
    const connection: AgentConnection = {
      prepare: () => Promise.resolve({ busy }),
      find: () => Promise.resolve({ found: false }),
      send: (_agent, id) => {
        sent.push(id);
        return Promise.resolve({ queueId: "queue" });
      },
      close() {},
    };
    delivery = new SubmissionNotifications(
      h.store.submissions,
      h.tracking,
      () => connection,
    );
    delivery.start();
    await until(() => h.store.submissions.notices()[0]?.attempts.length === 1);
    expect(sent).toHaveLength(0);
    busy = false;
    let notice = h.store.submissions.notices()[0];
    if (notice === undefined) throw new Error("No notice");
    h.store.submissions.saveNotice(notice, "pending", "Test retry", 0);
    await until(() => sent.length === 1);
    notice = h.store.submissions.notices()[0];
    if (notice === undefined) throw new Error("No notice");
    h.store.submissions.saveNotice(
      notice,
      "accepted",
      "Test absent queue recovery",
      0,
    );
    await until(() => sent.length === 2);
    expect(sent[0]).toBe(sent[1]);
  } finally {
    await delivery?.close();
    await h.close();
  }
});

test("receipt during send retains accepted transport evidence", async () => {
  const h = await harness(runner([]));
  let delivery: SubmissionNotifications | undefined;
  try {
    const value = h.service.submit(request("receipt-race"));
    await until(
      () => h.store.submissions.get(value.id).state === State.Succeeded,
    );
    let finish: ((value: { queueId: string }) => void) | undefined;
    const connection: AgentConnection = {
      prepare: () => Promise.resolve({ busy: false }),
      find: () => Promise.resolve({ found: false }),
      send: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      close() {},
    };
    delivery = new SubmissionNotifications(
      h.store.submissions,
      h.tracking,
      () => connection,
    );
    delivery.start();
    await until(() => finish !== undefined);
    const notice = h.store.submissions.notices()[0];
    if (notice === undefined || finish === undefined)
      throw new Error("No pending notice");
    h.store.tracking.acknowledgeMessage(notice.id, notice.recipient);
    finish({ queueId: "accepted-after-receipt" });
    await until(
      () => h.store.submissions.notices(true)[0]?.state === "accepted",
    );
    await delivery.close();
    delivery = undefined;
    await h.reopen();
    expect(h.store.submissions.notices()).toHaveLength(0);
    expect(h.store.submissions.notices(true)[0]?.state).toBe("accepted");
  } finally {
    await delivery?.close();
    await h.close();
  }
});
test("a changed policy source invalidates the cache and unverified citations block publication", async () => {
  const roles: Role[] = [],
    h = await harness(runner(roles));
  try {
    const first = h.service.submit(request("original-policy"));
    await until(
      () => h.store.submissions.get(first.id).state === State.Succeeded,
    );
    h.github.revision = "policy-v2";
    const second = h.service.submit(request("changed-policy"));
    await until(
      () => h.store.submissions.get(second.id).state === State.NeedsInput,
    );
    expect(roles.filter((role) => role === "policy")).toHaveLength(2);
    expect(h.github.writes).toBe(1);
    expect(h.store.submissions.get(second.id).detail).toContain(
      "Unverified requirement citation",
    );
  } finally {
    await h.close();
  }
});
test("cancelling parallel analysis prevents writer and publication", async () => {
  const roles: Role[] = [];
  let entered = false;
  const blocked: RunStage = (
    role,
    _input,
    _schema,
    _instructions,
    _model,
    signal,
  ) => {
    roles.push(role);
    entered = true;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Cancelled stage"));
        },
        { once: true },
      );
    });
  };
  const h = await harness(blocked);
  try {
    const value = h.service.submit(request("cancel"));
    await until(() => entered);
    h.service.cancel(value.id);
    await h.service.close();
    expect(h.store.submissions.get(value.id).state).toBe(State.Cancelled);
    expect(h.github.writes).toBe(0);
    expect(roles).not.toContain("writer");
  } finally {
    await h.close();
  }
});
