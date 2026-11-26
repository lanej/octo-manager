import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";

test("merge notice insertion and retirement signal inputs only when rows change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-notice-inputs-"));
  const store = new Store(directory);
  try {
    const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
      harness: "codex",
      endpoint: "local",
      sessionId: "notice-inputs",
    });
    const sequence = store.sequence();
    const signals = () => store.eventsSince(sequence).filter((event) => event.kind === "merge_notification_updated");
    store.merging.notice(pr, "reference", "fixture-reference", "one", "", true);
    expect(signals()).toHaveLength(1);
    store.merging.notice(pr, "reference", "fixture-reference", "one", "", true);
    expect(signals()).toHaveLength(1);
    store.merging.notice(pr, "reference", "fixture-reference", "retired", "", false);
    expect(signals()).toHaveLength(2);
    store.merging.notice(pr, "reference", "fixture-reference", "retired", "", false);
    expect(signals()).toHaveLength(2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
