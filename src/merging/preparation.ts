import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { RebaseWorkspace } from "../repairs/git.js";
import { rebaseSource } from "../repairs/github.js";
import { mechanicalConflicts } from "../repairs/mechanical.js";
import type { ConflictStore } from "../repairs/cases.js";
import type { MergeOperation, PreparationProfile } from "./contracts.js";
import { fingerprint } from "./policy.js";
function atKey(value: unknown, key: string[]): unknown {
  let current = value;
  for (const part of key) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    )
      throw new Error("TOML key is not a scalar path");
    current = Object.fromEntries(Object.entries(current))[part];
  }
  return current;
}
export function repin(
  source: string,
  profile: PreparationProfile,
  sha: string,
): string {
  if (
    profile.kind !== "toml_revision" ||
    profile.key === undefined ||
    profile.expectedValue === undefined
  )
    throw new Error("TOML preparation needs an exact key and expected value");
  const current = atKey(Bun.TOML.parse(source), profile.key);
  if (current === sha) return source;
  if (current !== profile.expectedValue)
    throw new Error("TOML revision changed; owner assessment required");
  const table = profile.key.slice(0, -1).join("."),
    key = profile.key.at(-1);
  let section = "",
    changes = 0;
  const result = source
    .split(/(?<=\n)/u)
    .map((line) => {
      const header = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?\r?\n?$/u.exec(line);
      if (header !== null) section = header[1] ?? "";
      if (section !== table) return line;
      const match =
        /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(["'])([a-f0-9]{40}(?:[a-f0-9]{24})?)\4(\s*(?:#.*)?\r?\n?)$/u.exec(
          line,
        );
      if (match === null || match[2] !== key || match[5] !== current)
        return line;
      changes++;
      return `${match[1] ?? ""}${key ?? ""}${match[3] ?? ""}${match[4] ?? ""}${sha}${match[4] ?? ""}${match[6] ?? ""}`;
    })
    .join("");
  if (changes !== 1 || atKey(Bun.TOML.parse(result), profile.key) !== sha)
    throw new Error(
      "TOML recipe requires one unambiguous bare key with a quoted revision",
    );
  return result;
}
export interface PrepareRequest {
  url: string;
  operation: MergeOperation;
  beforePush: (head: string, workspace: string) => void;
  signal: AbortSignal;
}
export type Preparer = (input: PrepareRequest) => Promise<string>;
export function preparer(
  root: string,
  cases: ConflictStore,
  options: {
    source?: typeof rebaseSource;
    workspace?: (
      directory: string,
      source: import("../repairs/types.js").RebaseSource,
      signal: AbortSignal,
    ) => RebaseWorkspace;
  } = {},
): Preparer {
  return async ({ url, operation, beforePush, signal }) => {
    const profile = operation.preparation;
    if (profile === undefined) throw new Error("Preparation profile missing");
    const readSource = options.source ?? rebaseSource;
    const source = await readSource(url, signal);
    if (
      source.headSha !== operation.head ||
      source.targetRef !== operation.baseRef ||
      source.targetSha !== operation.baseSha
    )
      throw new Error("Preparation inputs moved");
    const directory = await mkdtemp(join(root, "merge-")),
      workspace =
        options.workspace?.(directory, source, signal) ??
        new RebaseWorkspace(directory, source, signal);
    await workspace.prepare();
    await workspace.git(["config", "user.name", "Octo Manager"]);
    await workspace.git(["config", "user.email", "octo-manager@localhost"]);
    await workspace.git(["config", "commit.gpgsign", "false"]);
    await workspace.git(["config", "core.hooksPath", "/dev/null"]);
    let paths = await workspace.rebase();
    for (let round = 1; paths.length > 0; round++) {
      if (round > 32)
        throw new Error("Rebase exceeded deterministic repair limit");
      const result = await mechanicalConflicts(
        workspace,
        paths,
        cases,
        operation.id,
        round,
      );
      if (result.remaining.length > 0)
        throw new Error(
          `Owner repair required: ${result.remaining.join(", ")}`,
        );
      await workspace.stage(paths);
      paths = await workspace.rebase(true);
    }
    if (profile.kind === "toml_revision") {
      if (
        profile.path === undefined ||
        operation.prerequisiteCommit === undefined
      )
        throw new Error(
          "TOML preparation needs path and merged prerequisite revision",
        );
      const content = await workspace.read(profile.path),
        updated = repin(content, profile, operation.prerequisiteCommit);
      if (updated !== content) {
        await writeFile(await workspace.safePath(profile.path), updated);
        await workspace.stage([profile.path]);
        await workspace.git([
          "-c",
          "user.name=Octo Manager",
          "-c",
          "user.email=octo-manager@localhost",
          "commit",
          "-m",
          `chore: update dependency revision to ${operation.prerequisiteCommit.slice(0, 8)}`,
        ]);
      }
    }
    const head = await workspace.validate(profile.checks, profile.timeoutMs);
    const latest = await readSource(url, signal);
    if (fingerprint(latest) !== fingerprint(source))
      throw new Error("Preparation source or target moved before push");
    if (head !== source.headSha) {
      await workspace.push(head, () => {
        beforePush(head, directory);
      });
    }
    return head;
  };
}
