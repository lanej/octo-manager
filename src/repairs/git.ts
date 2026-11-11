import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { cleanText } from "../domain.js";
import type { RebaseSource } from "./types.js";
import { tmpdir } from "node:os";
import type { ConflictVersions } from "./yaml.js";
const exec = promisify(execFile);
export class RebaseWorkspace {
  constructor(
    readonly directory: string,
    readonly source: RebaseSource,
    private signal: AbortSignal,
    private remote = `https://github.com/${source.repository}.git`,
  ) {}
  async git(args: string[], allowedFailure = false): Promise<string> {
    try {
      const result = await exec("git", args, {
        cwd: this.directory,
        signal: this.signal,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
        },
      });
      return result.stdout.trim();
    } catch (error) {
      if (
        allowedFailure &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      )
        return "";
      throw new Error(
        cleanText(
          error instanceof Error ? error.message : "Git operation failed",
          2000,
        ),
      );
    }
  }
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.git(["init"]);
    for (const ref of [this.source.headRef, this.source.targetRef])
      await this.git(["check-ref-format", `refs/heads/${ref}`]);
    await this.git(["remote", "add", "origin", this.remote]);
    await this.git([
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${this.source.headRef}:refs/remotes/origin/source`,
      `+refs/heads/${this.source.targetRef}:refs/remotes/origin/target`,
    ]);
    if (
      (await this.git(["rev-parse", "refs/remotes/origin/source"])) !==
        this.source.headSha ||
      (await this.git(["rev-parse", "refs/remotes/origin/target"])) !==
        this.source.targetSha
    )
      throw new Error("Branches moved before rebase; request a fresh attempt");
    const mergeCommits = await this.git([
      "rev-list",
      "--merges",
      `${this.source.targetSha}..${this.source.headSha}`,
    ]);
    if (mergeCommits !== "")
      throw new Error(
        "Source contains merge commits; explicit merge-preserving repair is required",
      );
    await this.git(["checkout", "--detach", this.source.headSha]);
  }
  async rebase(continuing = false): Promise<string[]> {
    try {
      await this.git(
        continuing
          ? ["rebase", "--continue"]
          : ["rebase", this.source.targetSha],
      );
      return [];
    } catch (error) {
      const paths = (
        await this.git(["diff", "--name-only", "--diff-filter=U", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      if (paths.length === 0) throw error;
      return paths;
    }
  }
  async safePath(path: string, write = false): Promise<string> {
    if (
      path === "" ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.split(/[\\/]/u).some((part) => part === ".git" || part === "..") ||
      relative(this.directory, resolve(this.directory, path)).startsWith(
        "..",
      ) ||
      resolve(this.directory, path) === this.directory
    )
      throw new Error("Invalid repair file path");
    const tracked = await this.git([
      "--literal-pathspecs",
      "ls-files",
      "--error-unmatch",
      "--",
      path,
    ]);
    if (tracked === "")
      throw new Error("Repair reads are limited to tracked files");
    let current = this.directory;
    for (const part of path.split("/")) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error("Symlinks require manual repair");
    }
    const info = await lstat(current);
    if (!info.isFile() || info.size > 256 * 1024)
      throw new Error(
        "Binary, deleted, or oversized files require manual repair",
      );
    if (
      write &&
      !(await this.git(["diff", "--name-only", "--diff-filter=U", "-z"]))
        .split("\0")
        .includes(path)
    )
      throw new Error("Writes are limited to current conflicted files");
    return current;
  }
  async read(path: string): Promise<string> {
    const text = await readFile(await this.safePath(path), "utf8");
    if (text.includes("\0"))
      throw new Error("Binary conflict requires manual repair");
    return text;
  }
  async write(path: string, content: string): Promise<void> {
    if (
      Buffer.byteLength(content) > 256 * 1024 ||
      /^(<<<<<<< |=======\s*$|>>>>>>> )/mu.test(content)
    )
      throw new Error("Resolution is too large or retains conflict markers");
    await writeFile(await this.safePath(path, true), content);
  }
  async stage(paths: string[]): Promise<void> {
    for (const path of paths) {
      const content = await this.read(path);
      if (/^(<<<<<<< |=======\s*$|>>>>>>> )/mu.test(content))
        throw new Error("Conflict markers remain");
      await this.git(["--literal-pathspecs", "add", "--", path]);
    }
  }
  async validate(checks: string[][], timeout: number): Promise<string> {
    if ((await this.git(["status", "--porcelain"])) !== "")
      throw new Error("Rebase did not leave a clean worktree");
    await this.git([
      "merge-base",
      "--is-ancestor",
      this.source.targetSha,
      "HEAD",
    ]);
    for (const command of checks) {
      const [binary, ...args] = command;
      if (binary === undefined || binary === "")
        throw new Error("Missing check command");
      try {
        await exec(binary, args, {
          cwd: this.directory,
          signal: this.signal,
          timeout,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        throw new Error(`Validation failed: ${binary} ${args.join(" ")}`);
      }
    }
    if ((await this.git(["status", "--porcelain"])) !== "")
      throw new Error(
        "Validation modified tracked or untracked files; inspect before pushing",
      );
    return this.git(["rev-parse", "HEAD"]);
  }
  async conflictInputs(
    path: string,
  ): Promise<{ refs: Partial<ConflictVersions>; inputs?: ConflictVersions }> {
    const refs: Partial<ConflictVersions> = {};
    const texts: Partial<ConflictVersions> = {};
    const entries = (
      await this.git([
        "--literal-pathspecs",
        "ls-files",
        "-u",
        "-z",
        "--",
        path,
      ])
    )
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const match = /^(100644|100755) ([0-9a-f]+) ([123])\t/u.exec(entry);
      if (match === null) continue;
      const blob = match[2],
        stage = match[3];
      if (blob === undefined) continue;
      const key =
        stage === "1" ? "base" : stage === "2" ? "target" : "replayed";
      refs[key] = blob;
      try {
        const { stdout } = await exec("git", ["cat-file", "blob", blob], {
          cwd: this.directory,
          signal: this.signal,
          timeout: 10000,
          maxBuffer: 256 * 1024,
          encoding: "buffer",
        });
        const value = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(stdout);
        if (!value.includes("\0")) texts[key] = value;
      } catch {
        /* Unsupported blob content remains unavailable alongside its reference. */
      }
    }
    if (
      texts.base === undefined ||
      texts.target === undefined ||
      texts.replayed === undefined
    )
      return { refs };
    return {
      refs,
      inputs: {
        base: texts.base,
        target: texts.target,
        replayed: texts.replayed,
      },
    };
  }
  async mergeText(inputs: ConflictVersions): Promise<string | undefined> {
    const directory = await mkdtemp(join(tmpdir(), "octo-yaml-"));
    try {
      for (const key of ["base", "target", "replayed"] as const)
        await writeFile(join(directory, key), inputs[key], { mode: 0o600 });
      try {
        const { stdout } = await exec(
          "git",
          [
            "merge-file",
            "-p",
            join(directory, "target"),
            join(directory, "base"),
            join(directory, "replayed"),
          ],
          { signal: this.signal, timeout: 10000, maxBuffer: 256 * 1024 },
        );
        return stdout;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number" &&
          error.code >= 1 &&
          error.code <= 127
        )
          return undefined;
        throw error;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async remoteHead(ref = this.source.headRef): Promise<string> {
    const line = await this.git(["ls-remote", "origin", `refs/heads/${ref}`]);
    return line.split(/\s/u)[0] ?? "";
  }
  async push(head: string): Promise<void> {
    if (
      (await this.remoteHead(this.source.targetRef)) !== this.source.targetSha
    )
      throw new Error("Target branch moved before push");
    await this.git([
      "push",
      "--no-follow-tags",
      `--force-with-lease=refs/heads/${this.source.headRef}:${this.source.headSha}`,
      "origin",
      `${head}:refs/heads/${this.source.headRef}`,
    ]);
  }
}
