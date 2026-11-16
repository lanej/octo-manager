import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IssueRecord } from "./contracts.js";
const exec = promisify(execFile);
// Coordinator Git effects must not execute files selected by the agent's checkout.
export async function issueGit(
  issue: IssueRecord,
  signal: AbortSignal,
  authorize: () => void,
) {
  const root = await realpath(issue.root);
  const workspace = await realpath(issue.workspace);
  const safe = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "protocol.ext.allow=never",
  ];
  const common = (
    await exec(
      "git",
      [...safe, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, signal, timeout: 5000 },
    )
  ).stdout.trim();
  let metadata = "";
  for (const entry of await readdir(join(common, "worktrees"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(common, "worktrees", entry.name);
    const pointer = (await readFile(join(directory, "gitdir"), "utf8")).trim();
    if (resolve(pointer) === join(workspace, ".git")) {
      metadata = directory;
      break;
    }
  }
  if (metadata === "")
    throw new Error(
      "Workspace is not a registered linked checkout of the enrolled repository",
    );
  const prefix = [`--git-dir=${metadata}`, `--work-tree=${workspace}`, ...safe];
  let config = "";
  try {
    config = (
      await exec(
        "git",
        [
          ...prefix,
          "config",
          "--null",
          "--name-only",
          "--get-regexp",
          "^filter\\..*\\.(clean|smudge|process|required)$",
        ],
        { cwd: root, signal, timeout: 5000 },
      )
    ).stdout;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 1))
      throw error;
  }
  const drivers = new Set(
    config
      .split("\0")
      .map(
        (key) =>
          /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key)?.[1],
      )
      .filter((name): name is string => name !== undefined),
  );
  for (const driver of drivers)
    for (const operation of ["clean", "smudge", "process", "required"])
      prefix.push(
        "-c",
        `filter.${driver}.${operation}=${operation === "required" ? "false" : ""}`,
      );
  const git = async (...args: string[]): Promise<string> => {
    authorize();
    const value = await exec("git", [...prefix, ...args], {
      cwd: root,
      signal,
      timeout: 30000,
      maxBuffer: 1048576,
    });
    return value.stdout.trim();
  };
  const checkFilters = async () => {
    const tracked = await git("diff", "--name-only", "-z", "HEAD");
    const untracked = await git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    );
    const files = [
      ...new Set(
        [...tracked.split("\0"), ...untracked.split("\0")].filter(
          (value) => value !== "",
        ),
      ),
    ];
    for (const file of files) {
      const attributes = await git("check-attr", "filter", "--", file);
      if (
        !attributes.endsWith(": unspecified") &&
        !attributes.endsWith(": unset")
      )
        throw new Error(
          "Issue commits with content filters require a sandboxed repository-specific adapter",
        );
    }
  };
  return { git, checkFilters };
}
