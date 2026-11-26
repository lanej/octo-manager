import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createTestRenderer } from "@opentui/core/testing";
import { dashboardView } from "../src/dashboard/view.js";
import { records } from "../src/dashboard/records.js";
import { SnapshotSchema } from "../src/gen/octomanager/v2/scheduler_pb.js";
import { TrackingState } from "../src/gen/octomanager/v2/tracking_pb.js";

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
