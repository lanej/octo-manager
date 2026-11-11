# Rebase repairs

Octo can rebase an explicitly selected, enrolled PR onto its current target branch. Git handles clean rebases without a model. If text conflicts remain, a separate bounded Pi session uses the repair profile’s Codex model and instructions. The owning session and its settings remain untouched. Octo owns fetching, staging, continuing the rebase, checks, pushing, and GitHub verification; the model can read tracked text and write only the current conflicted files.

## Configure and request

Repair profiles are separate from triage profiles. They authorize one repository and supply trusted local validation commands as argument arrays, not shell strings. Configure the expected GitHub check names so the interval before CI registers cannot be mistaken for success. Commands run in a fresh checkout: include dependency installation when your checks need it. Their output must leave the worktree clean, including untracked files not covered by the repository’s ignore rules. Profiles are loaded at coordinator startup and copied onto each attempt.

```json
{
  "repairs": {
    "rebase": {
      "repository": "owner/repo",
      "harness": "pi",
      "model": "gpt-6.1-terra",
      "instructions": "Preserve the intended changes from both branches. Report ambiguity rather than guessing.",
      "checks": [["git", "diff", "--check"], ["make", "check"]],
      "githubChecks": ["Checks"],
      "timeoutMs": 120000
    }
  }
}
```

Use the repository’s actual checks and a model available to the existing Codex authentication. The current repair adapter uses the existing isolated Pi worker; changing the profile model does not change the originating Codex session. Other harnesses fail validation until an adapter is implemented. No new credential setup or app-server configuration is required.

```sh
octo-manager serve --config /path/to/config.json --state /path/to/state
# Enroll the PR from its owning session first, as described in tracking.md.
octo-manager rebase --url https://github.com/owner/repo/pull/42 \
  --profile rebase --request-id pr42-rebase-1 --state /path/to/state
octo-manager repairs --state /path/to/state
octo-manager repairs --state /path/to/state --json
```

The rebase command authorizes a source-branch update for that request, subject to its profile and verification. It is not triggered by a notification or merely detecting a conflict. Replaying the same request ID returns the existing attempt; changed input is rejected. A new execution requires a new request ID. Only one active repair per PR is accepted.

## Execution and evidence

Each attempt fetches the source and target into its own private checkout under `STATE/repairs/ATTEMPT`. Both fetched revisions must match the fresh GitHub observation. The first increment supports open, same-repository PRs with linear source history. Forks, source merge commits, binary/deletion/symlink conflicts, and oversized files stop with an explanation. There is no blanket ours/theirs rule, automatic commit skipping, or generated-file recipe in this increment.

Git attempts the rebase first. Each conflict stop supplies its remaining files to a new isolated repair session. The session has no shell, Git, push, or general write tool. Writes cannot leave the tracked current conflict set; reads cannot traverse outside the checkout or enter `.git`. Extensions, repository context loading, and built-in file/shell tools are disabled by the existing worker resource loader. These tool restrictions do not sandbox trusted profile check commands or other processes running as the coordinator’s account.

After resolution, Octo checks for conflict markers, continues the rebase, confirms target ancestry and a clean worktree, and runs every configured local check. A fresh PR observation must still match the original source and target. The push uses an exact `--force-with-lease` for the observed source head and does not push tags. A concurrently changed source is not overwritten. Target checks are bounded observations rather than an atomic lock: a later target movement blocks verification and requires another attempt.

After a confirmed push, the attempt stays awaiting checks until GitHub observes the exact resulting head, unchanged target, mergeability, complete check evidence, and every configured GitHub check completed successfully, neutrally, or skipped. Any observed failed check fails the attempt. Empty or partial collections cannot prove success. Temporary GitHub read failures retain pending verification and retry after 15 seconds without rebasing or pushing again. Awaiting verification resumes after coordinator restart.

An interrupted running attempt or unknown push result becomes uncertain. It is never blindly replayed. Inspect the retained checkout, JSON history, and remote branch before requesting another execution. Stopping the coordinator aborts current work; this increment has no per-attempt cancellation command. Workspaces are retained for inspection and require explicit cleanup when no longer needed.

## Data and presentation

`RebaseInput` contains a request ID, PR URL, and profile name. `RepairAttempt` contains the immutable request and profile snapshot, PR reference, original source/target revisions, optional resulting revision, conflicted paths, whether an agent was used, current step, and timestamped step history. Times remain integer Unix milliseconds. Repair state is an enum: queued, running, awaiting checks, succeeded, blocked, failed, or uncertain. Steps distinguish fetch, rebase, resolve, checks, push, and verify without overloading transport delivery states.

SQLite migration 4 adds `repair_attempts` without rewriting existing jobs, tracking, observations, events, or activity. State and its timeline event commit together. A partial unique index prevents multiple active attempts for the same PR. `RequestRebase`, `ListRepairs`, and snapshots expose typed records through Connect; the CLI’s JSON output retains per-attempt history. A successful repair does not directly mark an old blocker resolved: the existing tracking policy applies later GitHub observations and retains obsolete blocker episodes as superseded.

Tracking shows rebase state and the resulting commit as a GitHub link, ahead of closed blocker history. Git-only repairs are labeled as such; model-backed repairs show the separate harness and model. Activity shows readable rebase progress with the PR link, without database IDs.
