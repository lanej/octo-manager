import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { expect, test } from "bun:test";
import {
  GitHubSubmissions,
  type WriteSubmissionGitHub,
} from "../src/submissions/github.js";
import type {
  SubmissionInput,
  WriterDraft,
} from "../src/submissions/contracts.js";
const a = "a".repeat(40),
  b = "b".repeat(40);
const input: SubmissionInput = {
  repository: "owner/repo",
  headRepository: "fork/repo",
  headRef: "feature",
  headSha: a,
  baseRef: "main",
  requestId: "fixture",
  purpose: "Keep state when returning",
  validation: [],
  draft: true,
  owner: { harness: "codex", endpoint: "local", sessionId: "fixture" },
};
const draft: WriterDraft = {
  title: "fix: retain state",
  body: "Retain selection when returning so navigation can continue.",
  requirementChecks: [],
  blockers: [],
};
function fixture() {
  let writes = 0,
    files: unknown[] = [
      { filename: "src/main.rs", status: "modified", patch: "+keep_state();" },
    ];
  const current = {
    html_url: "https://github.com/owner/repo/pull/10",
    state: "open",
    title: "Original",
    body: "Original description.",
    head: { sha: a, ref: "feature", repo: { full_name: "fork/repo" } },
    base: { sha: b, ref: "main" },
  };
  const calls: string[] = [];
  const read = (path: string): Promise<unknown> => {
    calls.push(path);
    if (path === "repos/owner/repo") return Promise.resolve({ private: false });
    if (path === "repos/private/context")
      return Promise.resolve({ private: true });
    if (path.includes("/git/ref/heads/"))
      return Promise.resolve({
        object: { sha: path.includes("fork/repo") ? a : b },
      });
    if (path.includes("/compare/")) return Promise.resolve({ files });
    if (path.includes("/git/trees/"))
      return Promise.resolve({
        truncated: false,
        tree: [
          {
            path: "octo-manager.toml",
            type: "blob",
            sha: "config",
            mode: "100644",
          },
        ],
      });
    if (path.endsWith("/git/blobs/config"))
      return Promise.resolve({
        encoding: "base64",
        content: Buffer.from("schema_version = 1\n").toString("base64"),
      });
    if (path.includes("/issues/"))
      return Promise.resolve({
        title: "Keep navigation state",
        body: "Returning loses the selection.",
        html_url:
          "https://github.com/" +
          (path.includes("private") ? "private/context" : "owner/repo") +
          "/issues/7",
        updated_at: "2026-11-14T00:00:00Z",
      });
    if (path.endsWith("/pulls/10")) return Promise.resolve(current);
    if (path.includes("/pulls?")) return Promise.resolve([current]);
    return Promise.reject(new Error("Unexpected request: " + path));
  };
  const written: {
    method: string;
    fields: Record<string, string | boolean>;
  }[] = [];
  const write: WriteSubmissionGitHub = (_path, fields, method) => {
    writes++;
    written.push({ method, fields });
    current.title = String(fields["title"]);
    current.body = String(fields["body"]);
    return Promise.resolve(current);
  };
  return {
    github: new GitHubSubmissions(read, write),
    calls,
    current,
    written,
    get writes() {
      return writes;
    },
    noDiff() {
      files = [];
    },
  };
}
const signal = () => new AbortController().signal;
test("snapshot resolves fork refs, repository TOML and GitHub context visibility", async () => {
  const f = fixture();
  const snap = await f.github.snapshot(
    { ...input, references: ["#7", "private/context#7"] },
    signal(),
  );
  expect(snap.contractToml).toBeUndefined();
  expect(snap.contract?.schema_version).toBe(1);
  expect(snap.contractSource?.blobSha).toBe("config");
  expect(snap.references?.map((ref) => ref.private)).toEqual([false, true]);
  expect(f.calls).toContain("repos/fork/repo/git/ref/heads/feature");
  expect(f.calls.some((path) => path.includes(b + "...fork%3A" + a))).toBe(
    true,
  );
});
test("policy discovery works without a change", async () => {
  const f = fixture();
  f.noDiff();
  expect(
    (await f.github.snapshot({ ...input, mode: "policy" }, signal())).files,
  ).toEqual([]);
  expect(f.github.snapshot(input, signal())).rejects.toThrow("No change");
});
test("updates protect observed collaborator edits and only replace title/body", async () => {
  const f = fixture(),
    request = { ...input, updateUrl: f.current.html_url };
  const snap = await f.github.snapshot(request, signal());
  f.current.body = "Collaborator changed this.";
  expect(f.github.verify(request, b, signal(), snap)).rejects.toThrow(
    "changed after preparation",
  );
  expect(f.writes).toBe(0);
  f.current.body = snap.existing?.body ?? "";
  f.current.head.ref = "different-ref-at-same-sha";
  expect(f.github.verify(request, b, signal(), snap)).rejects.toThrow(
    "changed after preparation",
  );
  f.current.head.ref = "feature";
  f.current.head.repo.full_name = "another-fork/repo";
  expect(f.github.verify(request, b, signal(), snap)).rejects.toThrow(
    "changed after preparation",
  );
  f.current.head.repo.full_name = "fork/repo";
  await f.github.verify(request, b, signal(), snap);
  const saved = await f.github.publish(
    request,
    draft,
    "<!-- marker -->",
    signal(),
  );
  expect(saved.body).toContain(draft.body);
  expect(f.written[0]?.method).toBe("PATCH");
  expect(Object.keys(f.written[0]?.fields ?? {}).sort()).toEqual([
    "body",
    "title",
  ]);
  expect(saved.headRepository).toBe("fork/repo");
  expect(saved.baseSha).toBe(b);
});
test("create and lost-response lookup preserve exact publication identity", async () => {
  const f = fixture();
  await f.github.publish(input, draft, "<!-- marker -->", signal());
  expect(f.written[0]?.fields["head"]).toBe("fork:feature");
  f.current.title = "Collaborator edited title";
  const found = await f.github.find(input, "<!-- marker -->", signal());
  expect(found?.title).toBe("Collaborator edited title");
  expect(found?.baseRef).toBe("main");
  expect(found?.headRepository).toBe("fork/repo");
});

test("remote confirmation distinguishes historical PR payload base from current target ref", async () => {
  const f = fixture();
  f.current.base.sha = "c".repeat(40);
  const published = await f.github.publish(
    { ...input, updateUrl: f.current.html_url },
    draft,
    "<!-- new marker -->",
    signal(),
  );
  expect(published.baseSha).toBe("c".repeat(40));
  expect(published.targetBaseSha).toBe(b);
});

test("actual update adapter snapshots round-trip through durable storage and malformed snapshots cannot poison it", async () => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "octo-update-snapshot-")),
    store = new Store(directory);
  try {
    const request = {
      ...input,
      mode: "prepare" as const,
      updateUrl: f.current.html_url,
    };
    const snapshot = await f.github.snapshot(request, signal());
    const value = store.submissions.request(request);
    store.submissions.save({ ...value, snapshot });
    expect(store.submissions.get(value.id).snapshot).toEqual(snapshot);
    if (snapshot.existing === undefined)
      throw new Error("Missing adapter update metadata");
    Reflect.set(snapshot.existing, "unsupportedProviderField", true);
    expect(() => store.submissions.save({ ...value, snapshot })).toThrow(
      "Invalid structured PR data",
    );
    expect(store.submissions.get(value.id).snapshot?.existing?.title).toBe(
      "Original",
    );
    expect(store.submissions.list()).toHaveLength(1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
