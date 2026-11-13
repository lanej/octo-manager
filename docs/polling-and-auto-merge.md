# Polling, quota forecasts, and auto-merge

Octo owns auto-merge. It does not need GitHub's repository-wide auto-merge setting or register GitHub auto-merge requests. A tracked PR starts with auto-merge off; enrollment and reference discovery never arm it.

## Auto-merge switch

In **Tracking**, press **a** to toggle the Charmed **Auto merge** switch for the selected PR. Agents use:

```sh
octo-manager auto-merge https://github.com/owner/repo/pull/42 --on --agent-id OWNER_ID
octo-manager merge-ready https://github.com/owner/repo/pull/42 --head FULL_SHA --agent-id OWNER_ID
octo-manager auto-merge https://github.com/owner/repo/pull/42 --off --agent-id OWNER_ID
```

Turning the switch on explicitly queues that PR and discovers expected check names from its complete cached check/workflow evidence. An empty check set still requires the owner to declare a no-CI policy; it never silently passes. The switch does not replace the owning agent's assessment of the exact head. New heads, target/owner/enrollment changes, actionable feedback, or policy changes invalidate readiness. Existing dependency and GitHub eligibility gates remain in force. A paused or cancelled chain takes precedence over the switch.

Turning the switch off revokes future dispatch and clears readiness. A push or merge already accepted by the remote may finish; Octo keeps observing and reporting its outcome. Schema 14 stores `autoMerge` on merge entries. The upgrade preserves older **explicitly queued** entries as enabled and never creates entries for other tracked PRs. Earlier coordinators cannot reopen this schema.

Merges use GitHub's asynchronous API with an expected head SHA and no rule bypass. Accepted request UUIDs and next-check deadlines are stored on the existing operation. Restart resumes result polling, never resubmits the merge. Unknown outcomes retain the operation lease; HTTP 409 means an existing remote request may still be running, not a definite failure. Native stacked PRs wait for all open predecessors to merge and their target branch to settle, preventing one switch from implicitly merging unselected downstack PRs. Retargeted or changed heads require renewed owner assessment.

Independent check-run IDs remain independent. Only cancelled workflow suites with a later successful invocation of the same workflow definition, automatic trigger, and head are omitted from the merge gate; the check-suite identity links their jobs. Failure/pending evidence and unknown suite relationships remain blocking. The original evidence remains in tracking history.

## Adaptive polling

Unchanged automatic polls back off from **1 → 2 → 4 → 8 → 15 minutes**. Head, target, lifecycle, check, review, feedback, or description changes reset the interval. Manual refresh and notification hints reset it too. Pending check evidence retains a two-minute ceiling, including after transient read failures. A GitHub rate-limit deadline always wins.

Optional `config.json` settings:

```json
{"polling":{"minimumMs":60000,"maximumMs":900000,"activeMaximumMs":120000}}
```

The minimum is at least one second, the maximum at most one hour, and the active ceiling must fall within those bounds. Poll scheduling stays inside the tracker and is transient, as before: restart starts from the minimum interval. It adds no database schedule or extra GitHub discovery calls.

## Dashboard forecast

The GitHub panel and its header distinguish **On track**, **Limit before reset**, **Quota exhausted**, and unavailable evidence. A forecast includes the recent units/hour, observation window, and projected balance at reset or exhaustion time. Times use the configured presentation timezone.

Forecasts use changes in GitHub's reported remaining balance within the same reset window, so REST requests and GraphQL points stay distinct and other tools sharing authentication count toward the estimate. No additional requests are made to calculate the forecast. At least two minutes of observations are required; history is bounded to ten minutes with at most one sample per minute. Observations older than three minutes, changed/reset balances, and insufficient history produce an unknown forecast. An observed zero balance is exhausted immediately without inventing a burn rate. These are estimates at the recent pace, not guarantees about future traffic.

## Upgrading older installs

Startup applies retirement to cached, settled **merged** PRs before polling. Complete terminal check evidence, complete review/feedback coverage, and no waiting check watch are required; history, ownership, and unread deliveries remain intact. Incomplete merged PRs keep draining, while closed-but-unmerged PRs still receive fresh verification and can be reactivated by notifications. Explicitly disabled records stay disabled. This avoids fetching every old merged PR just to retire it after an upgrade.
