# Issue lifecycle

Octo coordinates explicitly enrolled issues through investigation, implementation, testing, review, and acceptance verification. The issue application owns lifecycle decisions and evidence. Issue trackers, agent dispatchers, workspaces, and code hosts are separate ports; GitHub issues and Codex app-server are the installed adapters. A different tracker does not require replacing GitHub PR coordination. The coordinator owns tracker writes and publication; agents operate in isolated local checkouts.

## Repository configuration

Add an `issues` section to the repository's existing `octo-manager.toml`. Each stage profile needs a model available to the configured harness; model names below are illustrative. No issue is enrolled automatically by adding configuration. The issue URL must belong to the selected checkout's origin repository.

```toml
[issues]
auto_implement = false
auto_publish = false
proceed_under_assumptions = false
auto_follow_ups = false
max_concurrency = 1

[issues.profiles.investigation]
harness = "codex"
model = "gpt-6.1-terra"
instructions = "Investigate the cause and propose falsifiable acceptance criteria."
timeout_ms = 1800000

[issues.profiles.implementation]
harness = "codex"
model = "gpt-6.1-terra"
instructions = "Follow the installed project engineering guidance."
timeout_ms = 1800000

[issues.profiles.verification]
harness = "codex"
model = "gpt-6.1-terra"
instructions = "Assess every acceptance criterion against the merged revision."
timeout_ms = 1800000
```

Clarification defaults come from `.source-code.json`: research and alpha are immediate, beta is one hour, production is four hours, and an unknown stage disables the timer. Set `clarification_timeout_ms` or `clarification_timeout_disabled = true` to override. Immediate timing combines questions and a proposed remediation plan; it does not grant implementation permission. A timeout produces one assumptions-based plan per clarification round. Blocking questions still stop work, including when proceeding under assumptions is enabled.

Assignment `timeout_ms` is independent of clarification timing: it defaults to 30 minutes per assignment, including testing. Expiry requests interruption and blocks the issue only after execution is confirmed terminal; uncertain interruption keeps the slot. See [timeout flows](issue-flows.md#deadlines-timeouts-and-retries) for retry and transport-timeout behavior.

Implementation, publication, follow-up creation, and merging are separate authority decisions. Existing repository merging policy still controls automatic merging: production does not gain merge authority from an issue approval, comment, or clarification timeout. Changed repository policy invalidates recorded issue approvals. Malformed or unavailable policy blocks work; uncertain cancellation retains the assignment instead of starting another agent.

## Commands

Use a registered calling agent identity, through `--agent-id` or `OCTO_MANAGER_AGENT_ID`. Enrollment starts investigation on the shared scheduler. Configuration reloads and tracker observations are local coordinator work; opening the dashboard does not directly poll GitHub.

```sh
octo-manager issue track https://github.com/owner/repo/issues/12 --cwd /path/to/repo --agent-id AGENT_ID
octo-manager issue list
octo-manager issue show ISSUE_ID --full
# Approvals pin the brief version you inspected.
octo-manager issue approve ISSUE_ID --brief-version 1
octo-manager issue answer ISSUE_ID --text 'Keep the existing compatibility behavior.'
octo-manager issue approve-publication ISSUE_ID --brief-version 1
octo-manager issue approve-follow-up ISSUE_ID --text ASSIGNMENT_ID
octo-manager issue pause ISSUE_ID
octo-manager issue resume ISSUE_ID
octo-manager issue refresh ISSUE_ID
octo-manager issue cancel ISSUE_ID
```

Specify `--request-id` when retrying a mutating command after a lost response. Reusing it with different input is rejected. `issue list --offset N` pages twenty issues at a time. `issue show --before SEQUENCE --full` pages retained events; assignment inspection returns the latest ten attempts. Default agent-mode JSON is bounded; `--full` is a read-only inspection option.

## Work, evidence, and recovery

The [state-machine and flow guide](issue-flows.md) explains issue stages, orthogonal waiting conditions, clarification/comment handling, assignment recovery, authority gates, and external-effect reconciliation. Review it alongside configuration before enabling unattended progression.

The **7 Issues** dashboard tab shows stage, waiting reason, latest assigned role/state/model, linked PR, and the selected brief. Use `h/l` to select an issue and `j/k` to scroll. It holds at most fifty summaries; the CLI pages the full collection. `issue show --full` includes the latest ten brief versions, ten attempts, twenty pending effects, and fifty events. Only events have `--before` pagination.

Investigation, implementation, and verification use separate sessions; implementation can resume for tests and remediation. Codex sessions are named for the issue and current task, for example `Investigate owner/repo#42: Fix retries · 01234567`. The eight-character suffix is the session UUID prefix; resuming implementation for testing or remediation updates the task label while retaining that suffix. Names are bounded and strip control characters. A naming failure is recorded in assignment detail without blocking work. Existing sessions are renamed when next dispatched, rather than in a bulk migration. Profiles do not change the calling session. Agents receive read-only investigation/verification or workspace-write implementation permissions, with network access disabled. The coordinator creates local commits and performs authorized remote effects. Required project checks run in the sandboxed testing stage. Repositories whose changed paths need custom content filters require a repository-specific adapter.

Done records accepted verification evidence; tracker closure is still a separate effect. Verification uses a fresh default-branch checkout and checks the result's tracked PR source head, not an exact merge-commit checkout. New input found before closure returns work to investigation. External closure does not establish verification. Terminal issues are not automatically polled/reopened, and repeat enrollment returns their existing record. Preserve unfinished/unpushed native-manager workspaces when cleaning up.

Unknown dispatch or write outcomes retain their evidence. Post/follow-up creation reconciles stable markers without blind recreation; closure separately observes and retries an idempotent close-if-open operation. A late result cannot undo pause/cancel, and interrupt acceptance alone does not release agent ownership. Inspect the current waiting reason, assignment, pending effects and event history together. A completed effect can also record an intent retired as inapplicable, so its status alone is not proof of a remote write.
