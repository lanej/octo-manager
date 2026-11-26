import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { checked } from "../merging/contracts.js";
import type { IssueWorkspace } from "../issues/ports.js";
const exec = promisify(execFile);
export class ManagedIssueWorkspace implements IssueWorkspace {
  async allocate(root: string, ownerId: string, issueId: string): Promise<string> {
    const { stdout: remote } = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
    });
    const branch = remote.trim();
    await exec("git", ["fetch", "origin", branch.replace(/^origin\//u, "")], {
      cwd: root,
      timeout: 30000,
    });
    const { stdout } = await exec(
      "worktree",
      ["create", "--agent", "codex", "--owner-id", ownerId, "--base", branch, "--json"],
      { cwd: root, timeout: 30000, maxBuffer: 1048576 },
    );
    const response = checked(
      Type.Object({
        result: Type.Object({
          id: Type.String(),
          path: Type.String(),
          state: Type.String(),
        }),
      }),
      JSON.parse(stdout),
    );
    if (response.result.state !== "active") throw new Error(`Issue ${issueId} workspace is not active`);
    return response.result.path;
  }
}
