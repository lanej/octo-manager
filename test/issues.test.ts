import { join } from "node:path";
import { test, expect } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { IssueStore } from "../src/issues/store.js";
import { IssueService } from "../src/issues/service.js";
import {
  IssueStage,
  Waiting,
  Role,
  AttemptState,
  clarificationTimeout,
  type Assignment,
  type StageResult,
  type IssuePolicy,
  type TrackerObservation,
} from "../src/issues/contracts.js";
import type {
  IssueTracker,
  AgentDispatcher,
  DispatchStatus,
  IssueCodeHost,
} from "../src/issues/ports.js";
const brief = {
  version: 1,
  outcome: "Correct the result",
  scope: "One calculation",
  criteria: ["The example returns 42"],
  assumptions: [],
  questions: [],
  blockingQuestions: false,
};
function fixture(overrides: Partial<IssuePolicy> = {}) {
  let now = 100000;
  const db = new DatabaseSync(":memory:");
  const store = new IssueStore(db, () => now);
  const profile = {
    harness: "fake",
    model: "controlled",
    instructions: "",
    timeoutMs: 1000000,
  };
  const policy: IssuePolicy = {
    hash: "one",
    stage: "beta",
    timeoutMs: 3600000,
    implement: false,
    publish: false,
    assumptions: false,
    followUps: false,
    concurrency: 1,
    profiles: {
      investigation: profile,
      implementation: profile,
      verification: profile,
    },
    ...overrides,
  };
  let observation: TrackerObservation = {
    title: "Wrong result",
    body: "Calculate 42",
    closed: false,
    comments: [],
    complete: true,
    revision: "1",
  };
  const posts = new Map<string, string>();
  let closeCount = 0;
  let createCount = 0;
  const tracker: IssueTracker = {
    provider: "test",
    verifyRepository: () => {},
    identify: (url) => ({
      provider: "test",
      project: "project",
      externalId: "1",
      url,
    }),
    observe: () => Promise.resolve(observation),
    post: (_ref, key, body) => {
      posts.set(key, body);
      return Promise.resolve(`https://test/${key}`);
    },
    findPost: (_ref, key) =>
      Promise.resolve(posts.has(key) ? `https://test/${key}` : undefined),
    createFollowUp: () => {
      createCount++;
      return Promise.resolve("https://test/followup");
    },
    findFollowUp: () => Promise.resolve(undefined),
    close: () => {
      closeCount++;
      observation = { ...observation, closed: true };
      return Promise.resolve();
    },
  };
  const assignments: Assignment[] = [];
  const results = new Map<string, StageResult>();
  let cancelCount = 0;
  const dispatcher: AgentDispatcher = {
    harness: "fake",
    submit: (assignment, checkpoint) => {
      assignments.push(assignment);
      checkpoint(`session-${assignment.role}`);
      return Promise.resolve({
        state: "running",
        sessionId: assignment.sessionId,
        turnId: assignment.id,
        detail: "accepted",
      });
    },
    inspect: (assignment) => {
      const value = results.get(assignment.id);
      const state: DispatchStatus =
        value != null
          ? {
              state: "completed",
              sessionId: assignment.sessionId,
              turnId: assignment.id,
              detail: "completed",
              result: value,
            }
          : {
              state: "running",
              sessionId: assignment.sessionId,
              turnId: assignment.id,
              detail: "running",
            };
      return Promise.resolve(state);
    },
    cancel: () => {
      cancelCount++;
      return Promise.resolve(true);
    },
  };
  let host = {
    merged: false,
    closed: false,
    head: "abc",
    checks: "passed" as const,
    feedback: [] as string[],
  };
  const codeHost: IssueCodeHost = {
    commit: () => Promise.resolve("abc"),
    publish: () => Promise.resolve({ url: "https://test/pr/1", head: "abc" }),
    enroll: () => {},
    inspect: () => host,
  };
  const service = new IssueService(
    store,
    {
      trackers: [tracker],
      dispatchers: [dispatcher],
      workspace: { allocate: () => Promise.resolve("/isolated/work") },
      codeHost,
      policy: () => policy,
    },
    () => now,
  );
  const enrolled = service.enroll(
    "test",
    "https://test/issue",
    process.cwd(),
    "owner",
    "enroll-1",
  );
  const complete = async (value: StageResult) => {
    const assignment = assignments.at(-1);
    if (assignment == null) throw new Error("No assignment");
    results.set(assignment.id, value);
    await service.tick();
    return store.get(enrolled.id);
  };
  return {
    options: {
      trackers: [tracker],
      dispatchers: [dispatcher],
      workspace: { allocate: () => Promise.resolve("/isolated/work") },
      codeHost,
      policy: () => policy,
    },
    service,
    store,
    policy,
    assignments,
    results,
    posts,
    enrolled,
    complete,
    close: () => {
      db.close();
    },
    advance: (ms: number) => {
      now += ms;
    },
    observe: (value: Partial<TrackerObservation>) => {
      observation = { ...observation, ...value };
    },
    merge: () => {
      host = { ...host, merged: true };
    },
    counts: () => ({ closeCount, createCount, cancelCount }),
  };
}
test("issue steel thread requires brief approval, tests, merge and separate verification", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    expect(f.assignments[0]?.role).toBe(Role.Investigation);
    let issue = await f.complete({
      disposition: "brief",
      summary: "Investigated",
      evidence: ["example"],
      brief,
    });
    expect(issue.waiting).toBe(Waiting.Approval);
    await f.service.tick();
    expect(f.assignments).toHaveLength(1);
    expect(() =>
      f.service.command(issue.id, "approve", "", 0, "wrong-approval"),
    ).toThrow();
    f.service.command(issue.id, "approve", "", 1, "approval");
    await f.service.tick();
    expect(f.assignments.at(-1)?.role).toBe(Role.Implementation);
    issue = await f.complete({
      disposition: "implemented",
      summary: "Fix made",
      evidence: ["diff"],
    });
    expect(issue.stage).toBe(IssueStage.Testing);
    await f.service.tick();
    issue = await f.complete({
      disposition: "tested",
      summary: "Test passes",
      evidence: ["test output"],
    });
    expect(issue.waiting).toBe(Waiting.Approval);
    f.service.command(issue.id, "approve-publication", "", 1, "publish");
    await f.service.tick();
    issue = await f.complete({
      disposition: "tested",
      summary: "PR published",
      evidence: ["test output"],
      prUrl: "https://test/pr/1",
      head: "abc",
    });
    expect(issue.stage).toBe(IssueStage.InReview);
    await f.service.tick();
    expect(f.assignments.at(-1)?.role).toBe(Role.Implementation);
    f.merge();
    await f.service.tick();
    expect(f.assignments.at(-1)?.role).toBe(Role.Verification);
    issue = await f.complete({
      disposition: "verified",
      summary: "Acceptance confirmed",
      evidence: ["example returns 42"],
      head: "abc",
    });
    expect(issue.stage).toBe(IssueStage.Done);
    expect(f.counts().closeCount).toBe(1);
  } finally {
    f.close();
  }
});
test("clarification deadlines publish one assumptions plan without granting implementation", async () => {
  const f = fixture({ timeoutMs: 1000 });
  try {
    await f.service.tick();
    let issue = await f.complete({
      disposition: "clarification",
      summary: "Need answer",
      evidence: [],
      brief: {
        ...brief,
        questions: ["Which rounding?"],
        blockingQuestions: false,
      },
    });
    expect(issue.waiting).toBe(Waiting.Clarification);
    expect(f.posts.size).toBe(1);
    await f.service.tick();
    expect(f.assignments).toHaveLength(1);
    f.advance(1001);
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).toBe("timeout");
    issue = await f.complete({
      disposition: "brief",
      summary: "Assume nearest",
      evidence: [],
      brief: {
        ...brief,
        questions: ["Which rounding?"],
        assumptions: ["Nearest"],
        blockingQuestions: false,
      },
    });
    expect(issue.timeoutPlanned).toBe(true);
    await f.service.tick();
    expect(f.assignments).toHaveLength(2);
    expect(f.posts.size).toBe(2);
  } finally {
    f.close();
  }
});
test("maturity defaults do not imply production merge authority", () => {
  expect(clarificationTimeout("research")).toBe(0);
  expect(clarificationTimeout("alpha")).toBe(0);
  expect(clarificationTimeout("beta")).toBe(3600000);
  expect(clarificationTimeout("production")).toBe(14400000);
  expect(clarificationTimeout("unknown")).toBeUndefined();
});
test("edited comments supersede active work before new assessment; stale results cannot advance", async () => {
  const f = fixture({ implement: true });
  try {
    await f.service.tick();
    await f.complete({
      disposition: "brief",
      summary: "Ready",
      evidence: [],
      brief,
    });
    await f.service.tick();
    const old = f.assignments.at(-1);
    if (old == null) throw new Error("Missing assignment");
    f.observe({
      comments: [
        {
          id: "comment",
          revision: "2",
          author: "reviewer",
          body: "Use a different example",
          url: "https://test/comment",
        },
      ],
    });
    f.advance(120001);
    await f.service.tick();
    expect(f.counts().cancelCount).toBe(1);
    expect(
      f.store.assignments().find((item) => item.id === old.id)?.state,
    ).toBe(AttemptState.Superseded);
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).toBe("comments");
    await f.complete({
      disposition: "brief",
      summary: "Updated example",
      evidence: [],
      brief: { ...brief, criteria: ["New example returns 42"] },
    });
    expect(f.store.get(f.enrolled.id).brief?.version).toBe(2);
  } finally {
    f.close();
  }
});
test("uncertain assignment survives recovery without duplicate dispatch", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    f.store.recover();
    await f.service.tick();
    expect(f.assignments).toHaveLength(1);
    expect(f.store.assignments()[0]?.state).toBe(AttemptState.Running);
  } finally {
    f.close();
  }
});
test("additional scope becomes a linked follow-up only when repository policy permits", async () => {
  const f = fixture({ followUps: true });
  try {
    f.observe({
      comments: [
        {
          id: "c",
          revision: "1",
          author: "someone",
          body: "Also support another format",
          url: "https://test/c",
        },
      ],
    });
    await f.service.tick();
    await f.complete({
      disposition: "follow_up",
      summary: "Separate scope",
      evidence: [],
      followUpTitle: "Another format",
      followUpBody: "Acceptance: parse format",
    });
    expect(f.counts().createCount).toBe(1);
  } finally {
    f.close();
  }
});

test("issue CLI traverses the generated socket API and exposes bounded persisted evidence", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Coordinator } = await import("../src/coordinator.js");
  const { schedulerClient } = await import("../src/client.js");
  const directory = await mkdtemp(join(tmpdir(), "octo-issues-api-"));
  const f = fixture();
  const coordinator = new Coordinator(directory, { issueOptions: f.options });
  try {
    await coordinator.start();
    const owner = coordinator.tracking.registerAgent({
      harness: "codex",
      endpoint: "local",
      sessionId: "issue-test",
      label: "Issue API test",
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "dist/cli.js",
        "issue",
        "track",
        "https://test/issue",
        "--provider",
        "test",
        "--agent-id",
        owner.id,
        "--state",
        directory,
        "--json",
        "--request-id",
        "cli-enroll",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
      },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    expect(output).toContain("reference");
    const client = schedulerClient(directory);
    const page = await client.listIssues({});
    expect(page.issues).toHaveLength(1);
    const issue = page.issues[0];
    if (issue === undefined) throw new Error("Issue missing");
    const inspected = await client.getIssue({ id: issue.id });
    expect(
      inspected.issue?.title === "" ||
        inspected.issue?.title === "Wrong result",
    ).toBe(true);
    expect(inspected.events.length).toBeGreaterThan(0);
    const again = await client.enrollIssue({
      provider: "test",
      url: "https://test/issue",
      root: process.cwd(),
      ownerAgentId: owner.id,
      requestId: "cli-enroll",
    });
    expect(again.issue?.id).toBe(issue.id);
    expect((await client.getSnapshot({})).snapshot?.issues).toHaveLength(1);
  } finally {
    await coordinator.close();
    f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed stage results retain failure evidence and permit an explicit new attempt", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    const issue = await f.complete({
      disposition: "verified",
      summary: "Premature",
      evidence: ["claim"],
      head: "abc",
    });
    expect(issue.stage).toBe(IssueStage.Investigation);
    expect(issue.waiting).toBe(Waiting.Blocked);
    expect(issue.assignmentId).toBe("");
    expect(f.store.assignments()[0]?.state).toBe(AttemptState.Failed);
    f.service.command(issue.id, "resume", "", 0, "retry-result");
    await f.service.tick();
    expect(f.assignments).toHaveLength(2);
  } finally {
    f.close();
  }
});
test("production clarification plan still requires implementation approval", async () => {
  const f = fixture({ stage: "production", timeoutMs: 14400000 });
  try {
    await f.service.tick();
    await f.complete({
      disposition: "clarification",
      summary: "Need direction",
      evidence: [],
      brief: {
        ...brief,
        questions: ["Desired behavior?"],
        blockingQuestions: false,
      },
    });
    f.advance(14400001);
    await f.service.tick();
    await f.complete({
      disposition: "brief",
      summary: "Proposed fallback",
      evidence: [],
      brief: {
        ...brief,
        questions: ["Desired behavior?"],
        assumptions: ["Keep compatibility"],
        blockingQuestions: false,
      },
    });
    await f.service.tick();
    expect(f.assignments).toHaveLength(2);
    expect(f.store.get(f.enrolled.id).stage).toBe(IssueStage.Investigation);
  } finally {
    f.close();
  }
});

test("authorized publication sends the tested draft through the code-host port", async () => {
  const f = fixture({ implement: true, publish: true });
  try {
    await f.service.tick();
    await f.complete({
      disposition: "brief",
      summary: "Ready",
      evidence: [],
      brief,
    });
    await f.service.tick();
    await f.complete({
      disposition: "implemented",
      summary: "Committed",
      evidence: ["diff"],
    });
    await f.service.tick();
    const issue = await f.complete({
      disposition: "tested",
      summary: "Acceptance passes",
      evidence: ["test output"],
      head: "abc",
      draft: {
        title: "fix: correct calculation",
        body: "Correct the calculation and verify the example.",
      },
    });
    expect(issue.stage).toBe(IssueStage.InReview);
    expect(issue.prUrl).toBe("https://test/pr/1");
    expect(f.service.mergeAllowed(issue.prUrl)).toBe(true);
  } finally {
    f.close();
  }
});

test("new comments do not resume an explicitly paused issue", async () => {
  const f = fixture();
  try {
    f.service.command(f.enrolled.id, "pause", "", 0, "pause");
    f.observe({
      comments: [
        {
          id: "late",
          revision: "1",
          author: "reader",
          body: "More context",
          url: "https://test/comment",
        },
      ],
    });
    await f.service.tick();
    expect(f.store.get(f.enrolled.id).waiting).toBe(Waiting.Paused);
    expect(f.assignments).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("pause and cancel during awaited inspection cannot be overwritten by a stage result", async () => {
  for (const operation of ["pause", "cancel"]) {
    const f = fixture();
    try {
      await f.service.tick();
      const dispatcher = f.options.dispatchers[0];
      if (dispatcher === undefined) throw new Error("No dispatcher");
      let release: ((value: DispatchStatus) => void) | undefined;
      let enter: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      dispatcher.inspect = () => {
        enter?.();
        return new Promise((resolve) => {
          release = resolve;
        });
      };
      const pending = f.service.tick();
      await entered;
      f.service.command(
        f.enrolled.id,
        operation,
        "",
        0,
        `concurrent-${operation}`,
      );
      const assignment = f.assignments[0];
      if (assignment === undefined || release === undefined)
        throw new Error("Inspection not held");
      release({
        state: "completed",
        sessionId: assignment.sessionId,
        turnId: assignment.id,
        detail: "Completed late",
        result: { disposition: "brief", summary: "Ready", evidence: [], brief },
      });
      await pending;
      const current = f.store.get(f.enrolled.id);
      expect(operation === "cancel" ? current.stage : current.waiting).toBe(
        operation === "cancel" ? IssueStage.Cancelled : Waiting.Paused,
      );
      expect(current.brief).toBeUndefined();
      expect(f.posts.size).toBe(0);
    } finally {
      f.close();
    }
  }
});
test("interrupt acceptance retains the assignment slot until terminal confirmation", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    const dispatcher = f.options.dispatchers[0];
    if (dispatcher === undefined) throw new Error("No dispatcher");
    let terminal = false;
    dispatcher.cancel = () => Promise.resolve(terminal);
    f.service.command(f.enrolled.id, "pause", "", 0, "interrupt-pause");
    await f.service.tick();
    f.service.command(f.enrolled.id, "resume", "", 0, "interrupt-resume");
    await f.service.tick();
    expect(f.assignments).toHaveLength(1);
    expect(f.store.get(f.enrolled.id).assignmentId).not.toBe("");
    terminal = true;
    await f.service.tick();
    expect(f.store.get(f.enrolled.id).assignmentId).toBe("");
    await f.service.tick();
    expect(f.assignments).toHaveLength(2);
  } finally {
    f.close();
  }
});
test("a late code-host commit confirmation cannot undo an operator pause", async () => {
  const f = fixture({ implement: true });
  try {
    await f.service.tick();
    await f.complete({
      disposition: "brief",
      summary: "Ready",
      evidence: [],
      brief,
    });
    await f.service.tick();
    let release: ((head: string) => void) | undefined;
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.options.codeHost.commit = () => {
      enter?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = f.complete({
      disposition: "implemented",
      summary: "Edited",
      evidence: ["diff"],
    });
    await entered;
    f.service.command(f.enrolled.id, "pause", "", 1, "pause-during-commit");
    if (release === undefined) throw new Error("Commit not held");
    release("abc");
    await pending;
    expect(f.store.get(f.enrolled.id).waiting).toBe(Waiting.Paused);
    expect(f.store.get(f.enrolled.id).stage).toBe(IssueStage.Testing);
  } finally {
    f.close();
  }
});
test("a late publication confirmation cannot revive a cancelled issue", async () => {
  const f = fixture({ implement: true, publish: true });
  try {
    await f.service.tick();
    await f.complete({
      disposition: "brief",
      summary: "Ready",
      evidence: [],
      brief,
    });
    await f.service.tick();
    await f.complete({
      disposition: "implemented",
      summary: "Edited",
      evidence: ["diff"],
    });
    await f.service.tick();
    let release: ((value: { url: string; head: string }) => void) | undefined;
    let enter: (() => void) | undefined;
    let enrolled = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.options.codeHost.publish = () => {
      enter?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    f.options.codeHost.enroll = () => {
      enrolled++;
    };
    const pending = f.complete({
      disposition: "tested",
      summary: "Tested",
      evidence: ["test"],
      head: "abc",
      draft: { title: "Fix", body: "Fix body" },
    });
    await entered;
    f.service.command(
      f.enrolled.id,
      "cancel",
      "",
      1,
      "cancel-during-publication",
    );
    if (release === undefined) throw new Error("Publication not held");
    release({ url: "https://test/pr/1", head: "abc" });
    await pending;
    expect(f.store.get(f.enrolled.id).stage).toBe(IssueStage.Cancelled);
    expect(enrolled).toBe(0);
  } finally {
    f.close();
  }
});

test("unrelated comments preserve clarification waiting and its original deadline", async () => {
  const f = fixture({ timeoutMs: 180000 });
  try {
    await f.service.tick();
    const waiting = await f.complete({
      disposition: "clarification",
      summary: "Need rounding policy",
      evidence: [],
      brief: {
        ...brief,
        questions: ["Which rounding?"],
        blockingQuestions: true,
      },
    });
    f.observe({
      comments: [
        {
          id: "unrelated",
          revision: "1",
          author: "reader",
          body: "Thanks!",
          url: "https://test/comment",
        },
      ],
    });
    f.advance(120001);
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).toBe("comments");
    const assessed = await f.complete({
      disposition: "no_change",
      summary: "Acknowledgment only",
      evidence: [],
    });
    expect(assessed.waiting).toBe(Waiting.Clarification);
    expect(assessed.brief).toEqual(waiting.brief);
    expect(assessed.clarificationDueAt).toBe(waiting.clarificationDueAt);
    f.advance(60000);
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).toBe("timeout");
  } finally {
    f.close();
  }
});

test("adding an initially empty issue description supersedes active implementation", async () => {
  const f = fixture({ implement: true });
  try {
    f.observe({ body: "" });
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).not.toBe("comments");
    await f.complete({
      disposition: "brief",
      summary: "Title-only investigation",
      evidence: [],
      brief,
    });
    await f.service.tick();
    const active = f.assignments.at(-1);
    expect(active?.role).toBe(Role.Implementation);
    const epoch = f.store.get(f.enrolled.id).epoch;
    f.observe({ body: "Also preserve compatibility", revision: "2" });
    f.advance(120001);
    await f.service.tick();
    const observed = f.store.get(f.enrolled.id);
    expect(observed.epoch).toBe(epoch + 1);
    expect(
      observed.pendingComments.find((item) => item.id === "issue-body")?.body,
    ).toBe("Also preserve compatibility");
    expect(
      f.store.assignments().find((item) => item.id === active?.id)?.state,
    ).toBe(AttemptState.Superseded);
    await f.service.tick();
    expect(f.assignments.at(-1)?.purpose).toBe("comments");
    expect(f.assignments.at(-1)?.prompt).toContain(
      "Also preserve compatibility",
    );
  } finally {
    f.close();
  }
});
