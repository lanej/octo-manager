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

## Work and evidence

Stages are Investigation, Ready, In progress, Testing, In review, Verification, Done, and Cancelled. Waiting conditions preserve the stage: Needs clarification, Awaiting approval, Blocked, and Paused. The Issues dashboard tab shows the current stage, waiting reason, assigned work, linked PR, and brief. Use `h/l` to select an issue and `j/k` to scroll. Its snapshot contains at most fifty issues; the CLI pages the complete collection.

Investigation produces a versioned outcome, scope, acceptance criteria, assumptions, and questions. Answers are stored in Octo and posted to the issue. New or edited comments are assessed as corrections, clarifications, additional scope, or no change. Corrections invalidate the previous brief approval and supersede active work; additional scope can become a linked follow-up or an approval proposal. Comments supply task input, not authorization. Current linked PRs cannot auto-merge through Octo while scope is unresolved.

Investigation, implementation, and verification use separate sessions; implementation resumes for test and review fixes. Codex thread identity is checkpointed before submitting the assignment turn. Unknown acceptance is reconciled from the recorded thread and turn marker, never blindly resubmitted. Profiles do not change the calling session. Agents receive read-only investigation/verification or workspace-write implementation permissions with network access disabled. Local processes and repository tools still execute within the harness's configured sandbox; this is not a separate process-container isolation boundary.

Implementation edits stay local; the coordinator stages and commits them in the isolated issue branch so the agent does not need write access to shared Git metadata. Testing reports concrete evidence and, when publication is authorized, a caller-written title/body and exact tested commit. Octo checks the clean checkout and commit, pushes its separate branch without force, and uses the existing durable publisher to create and enroll the PR. Agent output alone cannot establish that publication succeeded. Descriptions must link the issue without closing keywords. Checks and review feedback return work to implementation. Confirmed merge starts acceptance verification from a fresh default-branch checkout. The verification result must name the merged PR head and include acceptance evidence; verification is an agent assessment, not an independent proof of correctness.

Only verified work reaches Done and requests tracker closure. Fresh issue input before closure defers completion for reassessment. External closure pauses new dispatch separately from Octo verification. Native-manager workspaces remain attached to issue/assignment evidence; inspect them before cleanup and preserve unfinished or unpushed work.

Tracker observations use the shared GitHub request queue, backoff, and rate-limit accounting. Incomplete comment collections retain previous evidence rather than establishing a new lifecycle. Published questions and plans carry stable reconciliation markers. An unconfirmed tracker write stays uncertain until observed; absence alone does not authorize a duplicate write. Notifications reuse the durable inbox and collapsing digest transport. Receipt does not resolve an issue or complete an agent assignment.

Coordinator Git effects resolve the linked Git directory from the original repository's metadata rather than trusting an agent-editable `.git` pointer. Hooks, filesystem monitors, signing programs, and content-filter execution are disabled for those effects; staged paths requiring content filters stop with an adapter requirement. Required project checks belong in the sandboxed testing stage. Pushes target the verified GitHub repository over HTTPS using the existing `gh` credential helper. Live authority is checked again before Git mutations and tracker/API dispatch; already-submitted external effects cannot be rolled back by a later pause. Their confirmations are retained without advancing cancelled or superseded work. Interrupt acknowledgment alone does not release an assignment: terminal execution must be observed first.
