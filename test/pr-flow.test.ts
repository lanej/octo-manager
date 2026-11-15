import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeFlow } from "../src/submissions/flow.js";
import type {
  SubmissionInput,
  RepositorySnapshot,
} from "../src/submissions/contracts.js";
test("oversized capture falls back explicitly, reuses validated scope, and preserves bad artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "octo-flow-boundary-")),
    binary = join(root, "pr-flow"),
    directory = join(root, "capture");
  const input: SubmissionInput = {
    requestId: "flow",
    repository: "owner/repo",
    headRef: "feature",
    headSha: "a".repeat(40),
    baseRef: "main",
    purpose: "Bound analysis",
    validation: [],
    draft: true,
    owner: { harness: "codex", endpoint: "local", sessionId: "fixture" },
  };
  const snapshot: RepositorySnapshot = {
    repository: input.repository,
    headSha: input.headSha,
    baseSha: "b".repeat(40),
    private: false,
    files: ["src/main.rs"],
    diff: "+changed",
    sources: [],
    sourceDigest: "fixture",
  };
  const analysis = {
    schema_version: 4,
    analysis_id: "fixture",
    provenance: {
      repository: input.repository,
      head_sha: input.headSha,
      base_sha: snapshot.baseSha,
      comparison_head_repository: input.repository,
      comparison_scope: "changed-files",
    },
    graph: { nodes: [], edges: [], diagnostics: [], coverage: {} },
  };
  const mapLines = [
    'if [ "$1" = "map" ]; then',
    "cat <<'JSON'",
    '{"analysis_id":"fixture","total":0,"records":[]}',
    "JSON",
    "exit 0",
    "fi",
  ];
  const script = [
    "#!/bin/sh",
    ...mapLines,
    "scoped=0",
    'for arg do last="$arg"; if [ "$arg" = "--changed-files-only" ]; then scoped=1; fi; done',
    'if [ "$scoped" = 0 ]; then',
    "cat >&2 <<'JSON'",
    '{"error":{"code":"analysis_too_large"}}',
    "JSON",
    "exit 1",
    "fi",
    'mkdir -p "$last"',
    "cat > \"$last/analysis.json\" <<'JSON'",
    JSON.stringify(analysis),
    "JSON",
    "",
  ].join("\n");
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  const signal = new AbortController().signal;
  try {
    expect(
      await analyzeFlow(input, snapshot, directory, signal, binary),
    ).toMatchObject({ available: true, scope: "changed-files", limited: true });
    expect(
      await readFile(join(directory, "full-capture-failure.txt"), "utf8"),
    ).toContain("Command failed");
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        ...mapLines,
        "echo unexpected-recapture >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    expect(
      await analyzeFlow(input, snapshot, directory, signal, binary),
    ).toMatchObject({ available: true, scope: "changed-files", limited: true });
    analysis.provenance.head_sha = "c".repeat(40);
    const artifact = join(directory, "changed-files/analysis.json");
    await writeFile(artifact, JSON.stringify(analysis));
    expect(
      await analyzeFlow(input, snapshot, directory, signal, binary),
    ).toMatchObject({ available: false });
    expect(await readFile(artifact, "utf8")).toBe(JSON.stringify(analysis));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
