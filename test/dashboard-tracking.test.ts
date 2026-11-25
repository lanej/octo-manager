import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createTestRenderer } from "@opentui/core/testing";
import { trackingView } from "../src/dashboard/tracking-view.js";
import {
  PendingActionSchema,
  TrackedPullRequestSchema,
  TrackingSnapshotSchema,
  TrackingState,
} from "../src/gen/octomanager/v2/tracking_pb.js";

test("Tracking keeps the inspected PR through live reordering and a narrow resize", async () => {
  await using screen = await createTestRenderer({
    width: 120,
    height: 14,
    kittyKeyboard: true,
  });
  const view = trackingView(screen.renderer, () => {
    screen.renderer.destroy();
  });
  const first = create(TrackedPullRequestSchema, {
    id: "first",
    url: "https://github.com/owner/repo/pull/1",
    trackingState: TrackingState.WATCHING,
  });
  const second = create(TrackedPullRequestSchema, {
    id: "second",
    url: "https://github.com/owner/repo/pull/2",
    ownerAgentId: "expected-owner",
    trackingState: TrackingState.DRAINING,
  });
  const actions = ["First action", "Second action", "Third action"].map(
    (summary) => create(PendingActionSchema, { prId: second.id, summary }),
  );
  view.update(
    create(TrackingSnapshotSchema, { prs: [first, second], actions }),
  );
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("› owner/repo #1");
  screen.mockInput.pressKey("j");
  screen.mockInput.pressEnter();
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("Owner: expected-owner");

  view.update(
    create(TrackingSnapshotSchema, { prs: [second, first], actions }),
  );
  screen.resize(58, 14);
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("Owner: expected-owner");
  expect(screen.captureCharFrame()).not.toContain("owner/repo #1");

  view.disconnected();
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("Disconnected");
  expect(screen.captureCharFrame()).toContain("Owner: expected-owner");
  for (let index = 0; index < 4; index++) screen.mockInput.pressKey("]");
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("Third action");
  view.update(
    create(TrackingSnapshotSchema, { prs: [first, second], actions }),
  );
  screen.resize(54, 14);
  await screen.flush();
  expect(screen.captureCharFrame()).toContain("Third action");

  screen.mockInput.pressEscape();
  await screen.waitForFrame((frame) => frame.includes("› owner/repo #2"));
});
