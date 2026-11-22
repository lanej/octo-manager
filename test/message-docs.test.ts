import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  messageDocumentation,
  updateMessageDocumentation,
} from "../scripts/generate-message-docs.js";

async function expectStale(output: URL): Promise<void> {
  const error: unknown = await updateMessageDocumentation(true, output).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("stale");
}

test("generated message catalog is current and includes clickable links and one-command examples", async () => {
  await updateMessageDocumentation(true);
  const text = messageDocumentation();
  expect(text).toContain(
    "[PR #42 @ aaaaaaaa](https://github.com/owner/repo/pull/42/commits/" +
      "a".repeat(40) +
      ") · Review feedback (3)",
  );
  expect(text).toContain("`octo-manager read 1234abcd`");
  expect(text).toContain("GitHub confirmed merge");
  expect(text).toContain("A direct turn contains one item");
  expect(text).toContain("Review feedback requires owner assessment");
  expect(text).not.toContain("Inspect:");
});

test("freshness check rejects missing or edited examples without rewriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-message-docs-"));
  const output = pathToFileURL(join(directory, "examples.md"));
  try {
    await expectStale(output);
    await updateMessageDocumentation(false, output);
    await updateMessageDocumentation(true, output);
    const current = await readFile(output, "utf8");
    const stale = current.replace(
      "Review feedback (3)",
      "Review feedback (999)",
    );
    expect(stale).not.toBe(current);
    await writeFile(output, stale);
    await expectStale(output);
    expect(await readFile(output, "utf8")).toBe(stale);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
