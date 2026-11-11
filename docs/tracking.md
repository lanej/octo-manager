# PR tracking and Codex handoffs

Tracking belongs to the TypeScript coordinator; the Go dashboard is its client. Tracked PRs exist independently of summary jobs. GitHub observations, pending actions, notification delivery, and worker completion have separate meanings.

## Enroll a PR

Start the coordinator with `bin/octo-manager serve`, then register a PR from its owning session:

```sh
bin/octo-manager track --url https://github.com/OWNER/REPO/pull/123 --harness codex --thread-id THREAD_ID --label 'Review session'
bin/octo-manager tracked
bin/octo-manager tracking --json
bin/octo-manager refresh PR_ID
bin/octo-manager actions PR_ID
```

Use the same `--state DIR` on every command when selecting a nondefault state directory. The tracking dashboard is **4 Tracking**; it shows ownership, observation freshness, pending actions, profile, and delivery state even when the PR has no worker runs. Press `u` to refresh. Existing Reviews/Output/State views remain available. The Reviews message feed retains its existing public-only restriction; private tracking shows check and effective-review metadata in Tracking.

Tracking accepts private PRs through your existing `gh` access. It does not send private PR bodies or review messages to Pi. Summary jobs remain public-only. GitHub metadata and local state may still be sensitive; the coordinator's state directory and socket retain owner-only access.

Open PRs refresh immediately and every minute. Closed/merged PRs remain visible and stop automatic refresh; explicitly refresh or reenroll to inspect a later reopening. Refresh failures retain the last successful observation and its original timestamp. Check/review collections are capped at 1,000 records per source; incomplete collections cannot establish new effective blockers or resolve existing ones. Unknown mergeability is never interpreted as conflict-free.

## Actions and ownership

Actions represent confirmed merge conflicts, current-head failed checks, and effective changes-requested reviews. Comments are informational. Repeated observations do not create duplicate unfinished actions. A recurring blocker after resolution creates another action, preserving the earlier episode.

```sh
bin/octo-manager action ACTION_ID
bin/octo-manager acknowledge ACTION_ID --agent-id AGENT_ID
bin/octo-manager working ACTION_ID --agent-id AGENT_ID
bin/octo-manager assign PR_ID --thread-id NEW_THREAD_ID
bin/octo-manager untrack PR_ID
```

Acknowledgment and work reporting require the current owner's agent ID. This is a local ownership contract, not authentication against other unrestricted processes under the same account. Reassignment resets unfinished actions to open, preserves ownership history in events, and cancels pending deliveries to the old owner. Same-owner enrollment resumes an untracked PR. Untracking disables polling and delivery while retaining history.

Only a later GitHub observation resolves a blocker. New heads supersede obsolete conflict/check actions. A push alone does not resolve requested changes. Closing or merging supersedes remaining actions. Worker success or an agent's prose is not verification that GitHub changed.

## Codex delivery

The Codex adapter attaches to the existing daemon using WebSocket frames over its local Unix socket. It does not start/restart the daemon or change Codex configuration. The CLI's `app-server proxy` is a raw byte proxy, so newline JSON over that proxy is not an app-server connection.

The default `turn` delivery reads thread status, resumes only unloaded threads, waits for busy threads, and starts a triage turn. This requires an app-server that can own the thread. A standalone daemon cannot resume a thread already owned by the desktop app.

For desktop-owned threads, opt into the installed Codex 0.167.1 experimental queue API:

```json
{"endpoints":{"local":{"delivery":"queue"}}}
```

Queue mode enables the experimental API capability and calls `thread/queue/add` with the stable delivery ID as `clientUserMessageId`. It retains the returned queue ID and reconciles uncertain admission through `thread/queue/list`, then thread history. Queue acceptance does not establish receipt, wake an idle desktop agent, or acknowledge the blocker. Octo does not call `thread/queue/start`, resume the desktop thread, or change its model, permissions, working directory, or instructions. A live Codex 0.167.1 desktop trial consumed a queued probe as an incoming message after the active turn completed; see [the acceptance record](live-acceptance.md#desktop-queue-delivery). Queue mode remains opt-in. Unattended idle wakeup remains unverified.

Neither mode claims exclusive ownership of Codex scheduling.

Notifications contain a stable delivery marker, PR/head evidence, profile preferences, and acknowledgment/inspection argv using the coordinator's exact Bun executable, CLI path, and state directory. They request triage and reporting only, not repairs or pushes. A profile's model preference does not change the originating thread's model.

A successful app-server response means delivered, not acknowledged. The receiving agent records acknowledgment through the provided CLI. If its sandbox cannot connect to Octo's socket, it must use its existing host approval flow or report that limitation. Octo never bypasses that boundary, writes SQLite through the agent, or auto-approves host requests.

Confirmed temporary failures retry after 5, 30, and 120 seconds. Explicit app-server rejection or exhausted retries becomes unavailable. Unknown acceptance becomes uncertain; bounded thread-history inspection may confirm delivery, but absence does not prove rejection. Restart recovers unfinished attempts as uncertain. No automatic blind resend follows an uncertain outcome.

```sh
bin/octo-manager tracking --json
bin/octo-manager retry-delivery DELIVERY_ID
```

Explicit retry resets the backoff budget while retaining numbered attempts. Retrying an uncertain delivery can duplicate work if the earlier message was accepted; inspect the thread before requesting it.

## Profiles and future harnesses

Configuration defaults to `$XDG_CONFIG_HOME/octo-manager/config.json`, or `~/.config/octo-manager/config.json`. Override with `serve --config PATH`. Configuration is validated at startup and is not hot-reloaded.

```json
{
  "profiles": {
    "go-lint": {
      "instructions": "Inspect the lint output and identify the smallest correction. Report only; do not edit or push.",
      "harness": "codex",
      "model": "YOUR_CHEAPER_MODEL"
    }
  },
  "rules": [
    { "kind": "check_failed", "checkName": "Go lint", "profile": "go-lint" }
  ],
  "endpoints": {
    "local": { "socket": "/absolute/path/to/app-server-control.sock" }
  }
}
```

Rules are evaluated in order; the first matching blocker kind and optional exact check name selects the profile. Defaults cover conflicts, failed checks, and requested changes. Profiles are copied onto actions. Reprofile unfinished actions explicitly after restarting with new configuration:

```sh
bin/octo-manager reprofile ACTION_ID
```

Agent references identify a harness, endpoint, and opaque session ID. Codex is the only implemented delivery adapter; unsupported registrations fail clearly. Harness versions are observations, not identity: agent records retain the last observed runtime, and each delivery attempt snapshots its observed version. Repair execution, harness/model dispatch, agent pools, and Paseo remain future clients of these records.

## Storage and protocol

The additive SQLite migration preserves existing jobs, events, and instance identity. Six tracking tables separate destinations, tracked PRs, immutable observations, actions, deliveries, and attempts. Strict column types, enum checks, foreign keys, and a partial unique index enforce structural invariants. State changes and their events commit atomically. Existing jobs are not automatically enrolled because their owners are unknown.

Delivery and attempt JSON can additionally retain `queueId`, the opaque Codex admission receipt. Delivered progress can include a presentation `note` describing queue acceptance; it is not agent acknowledgment. These optional fields require no SQLite migration, and older records remain readable.

All timestamps are integer Unix milliseconds. Event sequence numbers determine ordering. Observations and events are retained without automatic pruning in this increment. Connect snapshots expose tracking alongside jobs; event `pr_id` and `action_id` distinguish tracking from worker activity. `ListEvents` and `Watch` accept a PR filter or a job filter, never both.

The app-server adapter uses request types generated with Codex 0.167.1 and its experimental API surface. Regenerate using `bun scripts/generate-codex-types.ts` with that CLI version; review compatibility before changing the pin. The script retains only the required generated type dependency closure. Controlled transport tests exercise actual WebSocket framing, unchanged turn settings, and uncertain acceptance after disconnect.

## Target revisions and delivery diagnostics

Open-PR observations retain GitHub’s PR-reported `baseSha` separately from `targetBase: { ref, sha }`, read from the current target branch ref. GitHub can retain an older ancestor in the PR payload after the target branch advances. Conflict actions use the independently read target SHA and branch name. The reader brackets collection reads with target-ref and PR checks; a changed head, target, lifecycle, or mergeability rejects the refresh and retains the preceding observation. These bounded reads do not establish an atomic GitHub snapshot. Fetch and verify refs before executing a repair.

The dashboard labels the PR-reported base and current target separately. Historical observations lack current-target evidence; closed PR observations do not require a surviving target branch. Legacy conflict notifications explicitly mark an unverified target rather than relabeling the old SHA as current.

Codex RPC rejections retain the method, error code, bounded upstream message, and observed runtime version in the existing delivery and attempt reasons. Terminal controls are removed. Explicit rejection remains distinct from uncertain acceptance; this diagnostic change does not automatically resend an uncertain notification.


## Terminal links

PR, commit, and evidence references use Charmed’s OSC 8 link atom: a compact label retains its exact HTTPS destination. Tracking groups the PR, head, PR-reported base, and current target links in declaration order and wraps between complete items as the pane changes width. Missing revisions remain explicit. Hover, selection, and opening belong to the terminal.

With the dotfiles Kitty mappings, `⌘⇧O` opens the last visible web link and `⌘⇧U` selects a labeled OSC 8 hyperlink through Kitty’s native picker. The hidden destination is used even when the label contains only a PR number or abbreviated commit. Kitty’s ordinary detected-URL hints remain available through `Ctrl+Shift+E`.


## Review feedback

Tracked open PRs also forward submitted review summaries, inline code-review comments, and PR conversation comments to their current owning agent. Human and bot authors are included; empty bodies and pending review drafts are excluded. The first complete collection includes existing comments. Each new or edited content revision creates a `review_feedback` action and uses the same durable notification, acknowledgment, retry, and uncertain-admission recovery as other actions. A formal changes-requested review retains its separate blocker status.

A feedback record contains `source` (`review`, `inline`, or `conversation`), GitHub `id`, content `revision`, `author`, full `body`, and the original GitHub `url`. Inline records additionally retain the reviewed commit, file path, current line when available, and parent review ID. The content hash excludes mutable inline line placement, so a push making a comment outdated does not resend unchanged text. The snapshot and action's typed Protobuf feedback preserve these fields; the dashboard presents comment text, file/line, and the GitHub evidence link.

SQLite version 6 adds optional `pr_observations.feedback_json` and extends the checked action kind set while preserving existing action, delivery, attempt, event, and owner keys. Historical observations have no feedback evidence. Deduplication spans prior action states and coordinator restarts. Edited comments supersede their older action; a missing/deleted comment, new commit, or agent acknowledgment does not prove the feedback was resolved. Partial collection retains evidence without creating new feedback actions; the next complete refresh can deliver them.

Feedback is untrusted input and requests assessment/reporting only. It does not authorize edits, pushes, or GitHub replies. A future dispatcher can use a dedicated profile's harness/model preferences to route straightforward feedback to a cheaper repair agent while retaining the originating owner:

```json
{
  "profiles": {
    "review_feedback": {
      "instructions": "Assess whether the feedback is straightforward and propose the smallest response.",
      "harness": "codex",
      "model": "YOUR_CHEAPER_MODEL"
    }
  }
}
```

These are execution preferences stored with the action, not an implemented automatic repair policy. Notifications never override the receiving session's settings. The current polling reader bounds each collection to 1,000 records and does not claim an atomic GitHub snapshot.
