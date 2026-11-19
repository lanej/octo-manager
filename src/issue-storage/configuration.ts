import { homedir } from "node:os";
import { join } from "node:path";
import { loadIssuePolicy } from "../issues/config.js";
import type { IssueRepository } from "../issues/repository.js";
import { BeadsIssueRepository } from "./beads.js";

export function configuredIssueRepositories(
  env: NodeJS.ProcessEnv = process.env,
): (root: string) => IssueRepository | undefined {
  let repository: IssueRepository | undefined;
  return (root) => {
    if (loadIssuePolicy(root).storage !== "beads") return undefined;
    repository ??= new BeadsIssueRepository(
      env["OCTO_MANAGER_BEADS_WORKSPACE"] ??
        join(homedir(), ".local/state/beads-service/workspace"),
      env["OCTO_MANAGER_BEADS_BINARY"] ?? "bd",
    );
    return repository;
  };
}
