import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createTestRenderer } from "@opentui/core/testing";
import { dashboardLink } from "../src/dashboard/links.js";
import { dashboardView } from "../src/dashboard/view.js";
import { records } from "../src/dashboard/records.js";
import { SnapshotSchema } from "../src/gen/octomanager/v2/scheduler_pb.js";
import {
  ActionState,
  DeliveryState,
  TrackingState,
} from "../src/gen/octomanager/v2/tracking_pb.js";

test("Tracking retains the selected PR and inspection when observations reorder", async () => {
  await using terminal = await createTestRenderer({
    width: 120,
    height: 17,
    kittyKeyboard: true,
  });
  const first = {
    id: "first",
    url: "https://github.com/owner/repo/pull/1",
    trackingState: TrackingState.WATCHING,
    enabled: true,
  };
  const second = {
    id: "second",
    url: "https://github.com/owner/repo/pull/2",
    trackingState: TrackingState.DRAINING,
    ownerAgentId: "expected-owner",
    enabled: true,
  };
  let snapshot = create(SnapshotSchema, { tracking: { prs: [first, second] } });
  const view = dashboardView(terminal.renderer, {
    changed() {
      update();
    },
    action() {},
    quit() {},
  });
  function update() {
    view.update(
      records(view.screen, snapshot, () => "Unknown", 24),
      "Live",
      "",
    );
  }
  update();
  terminal.mockInput.pressKey("d");
  terminal.mockInput.pressKey("4");
  await terminal.flush();
  expect(terminal.captureCharFrame()).toContain("› owner/repo #1");
  terminal.mockInput.pressKey("j");
  terminal.mockInput.pressEnter();
  await terminal.flush();
  expect(terminal.captureCharFrame()).toContain("Owner: expected-owner");

  snapshot = create(SnapshotSchema, {
    tracking: { prs: [second, first] },
    mergeStatuses: [{ prId: second.id, state: "uncertain" }],
  });
  update();
  terminal.resize(58, 17);
  await terminal.flush();
  expect(terminal.captureCharFrame()).toContain("Owner: expected-owner");
  expect(terminal.captureCharFrame()).toContain("Merge outcome unknown");
  expect(terminal.captureCharFrame()).not.toContain("owner/repo #1");

  terminal.mockInput.pressEscape();
  await terminal.waitForFrame((frame) => frame.includes("› owner/repo #2"));
  terminal.mockInput.pressEscape();
  await terminal.waitForFrame((frame) =>
    frame.includes("OCTO MANAGER  / Attention"),
  );
  expect(terminal.captureCharFrame()).toContain("Merge outcome unknown");
});

test("Attention excludes closed PRs with historical uncertain merge operations", () => {
  const snapshot = create(SnapshotSchema, {
    tracking: {
      prs: [
        {
          id: "closed",
          url: "https://github.com/owner/repo/pull/1",
          observation: { lifecycle: "closed" },
        },
        {
          id: "open",
          url: "https://github.com/owner/repo/pull/2",
          observation: { lifecycle: "open" },
        },
      ],
    },
    mergeStatuses: [
      { prId: "closed", state: "uncertain" },
      { prId: "open", state: "uncertain" },
    ],
  });
  expect(
    records("Attention", snapshot, () => "Unknown", 24).map((row) => row.prId),
  ).toEqual(["open"]);
  expect(
    records("Deliveries", snapshot, () => "Unknown", 24).map((row) => row.prId),
  ).toEqual(["open", "closed"]);
});

test("wide Attention keeps long subjects inside the list and shows delivery evidence beside it", async () => {
  await using terminal = await createTestRenderer({
    width: 108,
    height: 21,
    kittyKeyboard: true,
  });
  const subject =
    "an-intentionally-long-organization-name/a-long-repository-name";
  const snapshot = create(SnapshotSchema, {
    tracking: {
      prs: [
        {
          id: "first",
          url: `https://github.com/${subject}/pull/1`,
          enabled: true,
        },
      ],
    },
    mergeStatuses: [{ prId: "first", state: "uncertain" }],
  });
  const view = dashboardView(terminal.renderer, {
    changed() {},
    action() {},
    quit() {},
  });
  view.update(
    records("Attention", snapshot, () => "Unknown", 24),
    "Live",
    "",
  );
  await terminal.flush();
  const frame = terminal.captureCharFrame();
  expect(frame).toContain("│  │");
  expect(frame).toContain("NEXT ACTION");
  expect(frame).toMatch(/› an-intentionally-long-[\w-]+…\s*│/u);
});

test("delivery evidence retains its exact link target and distinct categorical pills", async () => {
  await using terminal = await createTestRenderer({
    width: 80,
    height: 40,
    kittyKeyboard: true,
  });
  const url = "https://github.com/owner/repo/pull/42";
  const evidence = url + "?view=changes#pullrequestreview-712";
  const snapshot = create(SnapshotSchema, {
    tracking: {
      prs: [
        {
          id: "tracked",
          url,
          enabled: true,
          ownerAgentId: "dev",
          trackingState: TrackingState.WATCHING,
          observation: {
            headSha: "fixture",
            lifecycle: "open",
            targetBase: { ref: "refs/heads/main", sha: "base" },
          },
        },
      ],
      actions: [
        {
          id: "action",
          prId: "tracked",
          ownerAgentId: "dev",
          summary: "Verify the retry budget",
          state: ActionState.OPEN,
          evidenceUrl: evidence,
        },
      ],
      deliveries: [
        {
          id: "delivery",
          actionId: "action",
          recipientAgentId: "dev",
          state: DeliveryState.UNCERTAIN,
        },
      ],
    },
  });
  const view = dashboardView(
    terminal.renderer,
    {
      changed() {
        update();
      },
      action() {},
      quit() {},
    },
    "dark",
  );
  function update() {
    view.update(
      records(view.screen, snapshot, () => "Unknown", 24),
      "Live",
      "",
    );
  }
  update();
  terminal.mockInput.pressEnter();
  await terminal.flush();
  const text = terminal.captureCharFrame();
  expect(text).toContain("Evidence: owner/repo #42 · review 712");
  expect(text).not.toContain("https://github.com/");
  expect(text).toContain("Target branch:  main");
  const spans = terminal.captureSpans().lines.flatMap((line) => line.spans);
  const color = (value: string) =>
    spans.find((span) => span.text.trim() === value)?.fg.toInts();
  expect(color("watching")).toEqual([143, 210, 166, 255]);
  expect(color("uncertain")).toEqual([240, 198, 120, 255]);
  expect(color("Unavailable")).toEqual([170, 184, 199, 255]);
  const selected = view.selected();
  const evidenceFact = selected?.delivery?.feedback.find(
    (item) => typeof item !== "string" && item.label === "Evidence",
  );
  expect(evidenceFact).toMatchObject({
    kind: "link",
    link: { label: "owner/repo #42 · review 712", url: evidence },
  });
});

test("compact links retain external hosts and decline unsafe terminal URLs", () => {
  expect(dashboardLink("https://build.example.org/runs/812?step=3")).toEqual({
    label: "build.example.org/runs/812?step=3",
    url: "https://build.example.org/runs/812?step=3",
  });
  expect(
    dashboardLink("https://github.com@external.example/project"),
  ).toBeUndefined();
  expect(
    dashboardLink("https://github.com/owner/repo/pull/42\u001b]8;;"),
  ).toBeUndefined();
  expect(dashboardLink("file:///tmp/report")).toBeUndefined();
});
