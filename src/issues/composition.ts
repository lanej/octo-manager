import { issueGit } from "./git-effects.js";
import { GitHubPublisher } from "../publication/publisher.js";
import { sdkTransport, type GitHubTransport } from "../github-sdk.js";
import { PublicationStore } from "../publication/store.js";
import { publishRequest } from "../publication/publisher.js";
import { readContract, githubRepository } from "../publication/contract.js";
import { ActionState } from "../tracking/types.js";
import type { TrackingService } from "../tracking/service.js";
import type { IssueCodeHost } from "./ports.js";
import { updateIssuePR } from "./publication.js";
import { currentMergeChecks } from "../merging/checks.js";
export function trackedCodeHost(
  tracking: TrackingService,
  stateDirectory: string,
  transport: GitHubTransport = sdkTransport(),
): IssueCodeHost {
  return {
    async commit(issue, signal, authorize) {
      const { git, checkFilters } = await issueGit(issue, signal, authorize);
      await checkFilters();
      const branch = await git("branch", "--show-current");
      if (branch === "" || ["main", "master"].includes(branch))
        throw new Error("Commit requires an isolated issue branch");
      const dirty = await git("status", "--porcelain");
      if (dirty !== "") {
        await git("add", "-A");
        await git(
          "commit",
          "-m",
          `feat(issue): ${issue.title.replace(/[\r\n]/gu, " ").slice(0, 60)}`,
        );
      }
      return git("rev-parse", "HEAD");
    },
    async publish(key, issue, value, signal, authorize) {
      if (value.draft === undefined || value.head === undefined)
        throw new Error("Tested head and caller-written PR draft required");
      const { git, checkFilters } = await issueGit(issue, signal, authorize);
      await checkFilters();
      const head = await git("rev-parse", "HEAD");
      if (head !== value.head)
        throw new Error(
          "Workspace changed after testing; retest before publication",
        );
      const dirty = await git("status", "--porcelain");
      if (dirty !== "")
        throw new Error("Commit tested source before publication");
      const branch = await git("branch", "--show-current");
      const base = (
        await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
      ).replace(/^origin\//u, "");
      if (
        branch === "" ||
        branch === base ||
        ["main", "master"].includes(branch)
      )
        throw new Error("Publication requires a separate issue branch");
      const repository = githubRepository(
        await git("remote", "get-url", "origin"),
      );
      if (repository === undefined)
        throw new Error("GitHub code host not configured");
      if (
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/|[\w.-]+\/[\w.-]+#|#)/iu.test(
          value.draft.body,
        )
      )
        throw new Error(
          "Issue PR descriptions must not close issues before verification",
        );
      const push = async (headRef: string) => {
        await git(
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${repository}.git`,
          `HEAD:refs/heads/${headRef}`,
        );
      };
      if (issue.prUrl !== "")
        return updateIssuePR(
          issue,
          { repository, branch, base, head },
          transport,
          push,
          signal,
          authorize,
        );
      const configured = readContract(issue.workspace);
      const journal = new PublicationStore(stateDirectory);
      try {
        const publication = journal.accept(
          {
            title: value.draft.title,
            body: `${value.draft.body}\n\nRelated issue: [${issue.ref.project}#${issue.ref.externalId}](${issue.ref.url})`,
            repository,
            root: issue.workspace,
            headRef: branch,
            headSha: head,
            baseRef: base,
            draft: false,
            contract: configured.contract,
            contractHash: configured.hash,
          },
          key,
        );
        await push(branch);
        const publisher = new GitHubPublisher(
          (request, requestSignal, beforeSend) =>
            transport(request, requestSignal ?? signal, () => {
              authorize();
              beforeSend?.();
            }),
        );
        await publishRequest(journal, publication.id, publisher);
        const confirmed = journal.get(publication.id);
        if (confirmed.state !== "published" || confirmed.url === undefined)
          throw new Error(confirmed.error?.fix ?? "PR publication unconfirmed");
        return { url: confirmed.url, head };
      } finally {
        journal.close();
      }
    },
    enroll(url, ownerId, root) {
      const agent = tracking.store.agents().find((item) => item.id === ownerId);
      if (agent == null) throw new Error("Issue owner agent is not registered");
      tracking.track(
        url,
        {
          harness: agent.harness,
          endpoint: agent.endpoint,
          sessionId: agent.sessionId,
        },
        root,
      );
    },
    inspect(url) {
      const pr = tracking.store.prs().find((item) => item.url === url);
      const observation = pr?.observation;
      if (pr === undefined || observation === undefined) return undefined;
      const checks = currentMergeChecks(observation);
      return {
        merged: observation.lifecycle === "merged",
        closed: observation.lifecycle === "closed",
        head: observation.headSha,
        checks: checks.some(
          (check) =>
            check.status === "completed" &&
            !["success", "neutral", "skipped"].includes(check.conclusion),
        )
          ? "failed"
          : checks.length > 0 &&
              checks.every((check) =>
                ["success", "neutral", "skipped"].includes(check.conclusion),
              )
            ? "passed"
            : "pending",
        feedback: tracking.store
          .actions()
          .filter(
            (action) =>
              action.prId === pr.id &&
              action.progress.state !== ActionState.Resolved &&
              action.progress.state !== ActionState.Superseded &&
              ["review_feedback", "changes_requested", "check_failed"].includes(
                action.blocker.kind,
              ),
          )
          .map((action) => action.summary),
      };
    },
  };
}
