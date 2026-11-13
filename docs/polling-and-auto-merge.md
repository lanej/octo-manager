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

## Shared scheduler and cached views

The coordinator owns one GitHub scheduling tick. Its default cadence is one second. Tracking, notifications and merge reconciliation run from that clock; each retains its existing eligibility and freshness rules. Every GitHub API request, including pagination, logs, GraphQL and merge operations, passes through the shared dispatch gate.

Optional failure-log enrichment has a five-second total budget, including queue wait. If it expires, the notification proceeds with its evidence link and no excerpt.

Requests are serialized, with a default minimum two-second gap after completion before another starts. This conservative gap also covers slow authentication before an HTTP send. Long requests can slow throughput; delayed ticks never cause catch-up bursts. Interactive requests alternate with waiting background requests, oldest first within each class. GitHub cooldowns take precedence, independently for REST and GraphQL unless a secondary limit pauses both.

Unchanged PR observations back off from **1 → 2 → 4 → 8 → 15 minutes**. Pending check evidence retains a two-minute ceiling. Head, target, lifecycle, checks, reviews, feedback or description changes reset the interval. Refresh actions and notification hints request earlier work without bypassing dispatch spacing or cooldowns.

The dashboard subscribes to its selected object with `WatchDashboard`. It receives an initial stored frame, then another on each scheduler tick. Switching tabs or PRs changes the subscription; it does not directly fetch GitHub. Global Activity and GitHub views present local coordinator data. Reviews register interest in a public PR without enrolling it or changing ownership. Closing a view removes that interest; tracked PR monitoring continues independently.

Pressing `u` queues a refresh for the next available slot. Repeated requests collapse into existing work. Cached content remains visible with refresh status and observation time; a cache miss is pending, not a failed read. Errors retain the previous successful view and their own attempt metadata. “Next eligible” describes the scheduling deadline; requests may wait longer for pacing or cooldowns.

Optional `config.json` settings:

```json
{"polling":{"tickMs":1000,"requestSpacingMs":2000,"minimumMs":60000,"maximumMs":900000,"activeMaximumMs":120000}}
```

`tickMs` is an integer from 100 ms to one minute; `requestSpacingMs` must be at least the tick interval and at most one hour. The PR polling minimum is at least one second, the maximum at most one hour, and the active ceiling lies within those bounds. Omitting settings preserves the defaults above.

Schema 15 stores tracking/review schedules, review views and dispatch/cooldown deadlines. Restart retains backoff, requeues interrupted reads and preserves asynchronous merge identities. Review cache storage is bounded to 128 views and 16 MiB, evicting the oldest written view. Reopening an evicted view queues a refresh; reopening a failed first load preserves its retry deadline unless explicitly refreshed. Older coordinators reject schema 15.

The GitHub dashboard shows cadence, queued/in-flight requests, next dispatch and cooldowns alongside the existing budget forecasts. Display updates do not consume GitHub requests.

## Dashboard forecast

The GitHub panel and its header distinguish **On track**, **Limit before reset**, **Quota exhausted**, and unavailable evidence. A forecast includes the recent units/hour, observation window, and projected balance at reset or exhaustion time. Times use the configured presentation timezone.

Forecasts use changes in GitHub's reported remaining balance within the same reset window, so REST requests and GraphQL points stay distinct and other tools sharing authentication count toward the estimate. No additional requests are made to calculate the forecast. At least two minutes of observations are required; history is bounded to ten minutes with at most one sample per minute. Observations older than three minutes, changed/reset balances, and insufficient history produce an unknown forecast. An observed zero balance is exhausted immediately without inventing a burn rate. These are estimates at the recent pace, not guarantees about future traffic.

## Upgrading older installs

Startup applies retirement to cached, settled **merged** PRs before polling. Complete terminal check evidence, complete review/feedback coverage, and no waiting check watch are required; history, ownership, and unread deliveries remain intact. Incomplete merged PRs keep draining, while closed-but-unmerged PRs still receive fresh verification and can be reactivated by notifications. Explicitly disabled records stay disabled. This avoids fetching every old merged PR just to retire it after an upgrade.
