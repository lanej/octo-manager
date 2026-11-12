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

Open PRs refresh immediately and every minute. Closed/merged PRs remain visible and stop automatic refresh after any existing check watch finishes or is cancelled; explicitly refresh or reenroll to inspect a later reopening. Refresh failures retain the last successful observation and its original timestamp. Check/review collections are capped at 1,000 records per source; incomplete collections cannot establish new effective blockers or resolve existing ones. Unknown mergeability is never interpreted as conflict-free.

## Actions and ownership

Actions represent confirmed merge conflicts, current-head failed checks, effective changes-requested reviews, informational review feedback, and completed/superseded check-watch reports. Repeated observations do not create duplicate unfinished actions. A recurring blocker after resolution creates another action, preserving the earlier episode.

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

A successful app-server response means transport admission, not recipient receipt. The receiving agent records this message's receipt through `acknowledge-message`; `acknowledge` separately accepts its action. If its sandbox cannot connect to Octo's socket, it must use its existing host approval flow or report that limitation. Octo never bypasses that boundary, writes SQLite through the agent, or auto-approves host requests.

New messages retain immutable text before transport access. Transient delivery failures retry after 5, 30, then at most every 120 seconds while applicable; explicit app-server rejection remains unavailable and visible. Unknown acceptance becomes uncertain. Accepted unread messages are rechecked after five minutes. Octo checks queue and thread history before replay: a matching queue/history record defers resend, a lookup failure retains the message and retries the lookup after a minute, and absence permits replay using the same ID and exact text. Bounded absence cannot prove rejection, so duplicate receipt remains possible. Restart retains receipt-check deadlines and recovers interrupted sends as uncertain. Historical sends without frozen text are not reconstructed or automatically replayed.

```sh
bin/octo-manager tracking --json
bin/octo-manager retry-delivery DELIVERY_ID
```

Explicit retry resets backoff while retaining numbered attempts; messages already acknowledged cannot be retried. Retrying an uncertain delivery can duplicate work if the earlier message was accepted; inspect the thread before requesting it.

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

Codex RPC rejections retain the method, error code, bounded upstream message, and observed runtime version in the existing delivery and attempt reasons. Terminal controls are removed. Explicit rejection remains distinct from uncertain acceptance; lookup failure does not trigger a blind resend; unread-message recovery follows the inbox policy below.


## Terminal links

PR, commit, and evidence references use Charmed’s OSC 8 link atom: a compact label retains its exact HTTPS destination. Tracking groups the PR, head, PR-reported base, and current target links in declaration order and wraps between complete items as the pane changes width. Missing revisions remain explicit. Hover, selection, and opening belong to the terminal.

With the dotfiles Kitty mappings, `⌘⇧O` opens the last visible web link and `⌘⇧U` selects a labeled OSC 8 hyperlink through Kitty’s native picker. The hidden destination is used even when the label contains only a PR number or abbreviated commit. Kitty’s ordinary detected-URL hints remain available through `Ctrl+Shift+E`.


## Review feedback

Tracked open PRs also forward submitted review summaries, inline code-review comments, and PR conversation comments to their current owning agent. Human and bot authors are included; empty bodies and pending review drafts are excluded. The first complete collection includes existing comments. Each new or edited actionable content revision creates a `review_feedback` action and uses the same durable notification, acknowledgment, retry, and uncertain-admission recovery as other actions. A formal changes-requested review retains its separate blocker status.

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


## Durable agent inbox

Each newly dispatched delivery has one immutable inbox entry, addressed to its original recipient and identified by the delivery ID used in `[octo-delivery:ID]`. The coordinator records the exact text before opening its transport connection. Reprofiling or later action changes cannot rewrite previously sent text. An ordered sequence supports bounded per-agent pages; the inbox survives restarts independently of Codex queue retention.

```typescript
interface AgentMessage {
  sequence: number;         // Ordered inbox cursor, not a timestamp.
  id: string;               // Stable delivery/message identity, reused on replay.
  actionId: string;
  recipientAgentId: string;  // Original recipient, preserved across ownership changes.
  body: string;             // Exact immutable outgoing text.
  createdAt: number;        // Unix milliseconds.
  acknowledgedAt?: number;  // Recipient explicitly confirmed this message.
  applicable: boolean;      // False when cancelled, superseded, or no longer assigned.
}
```

Use the supplied message-specific receipt argv immediately after reading. A receipt means only that this message reached the recipient. It neither accepts nor resolves its action. If a replayed marker is already handled, record receipt again (idempotently) and avoid repeating work. Inspect the action's current owner and state before responding to old evidence. Messages for former owners remain in their historical inbox with `applicable: false`; they are not reassigned or replayed as current work.

```sh
bin/octo-manager inbox --agent-id AGENT_ID --json
bin/octo-manager inbox --agent-id AGENT_ID --after SEQUENCE --json
bin/octo-manager acknowledge-message DELIVERY_ID --agent-id AGENT_ID
bin/octo-manager inbox --agent-id AGENT_ID --include-acknowledged --json
```

`ListAgentMessages` returns at most 200 messages, `next_sequence`, and `has_more`. It defaults to unacknowledged records for the requested agent; inspect `applicable` before acting. Start unread recovery from sequence zero after reconnecting so a cursor advanced past an unacknowledged message does not hide it. A response cursor is a paging position, not a cumulative acknowledgment. `AcknowledgeMessage(id, agent_id)` records a delivery-specific, immutable receipt and rejects another recipient. These identifiers fit the existing owner-only local API contract; they are not cryptographic agent authentication.

The dashboard presents transport status and recipient receipt separately; Activity records receipt separately from action progress. Automatic recovery stops after receipt or when the message becomes inapplicable. Queue/history lookup failures are retained visibly rather than represented as failed sends. Replay is at least once, with stable IDs for recipient duplicate detection, and does not guarantee exactly-once execution or unattended wakeup. Agents can pull their unread inbox even when the transport is unavailable; automatic session-start inbox enrollment remains a separate integration.

SQLite version 7 adds `delivery_messages`, preserving all existing identities and histories. Payload/destination/receipt constraints prevent rewriting stored evidence. Older accepted or uncertain deliveries have unknown original payloads and no synthesized inbox entry; their legacy status remains visible. A pending legacy delivery gets frozen text when it is first attempted under this version.


## Background check completion

Enroll the PR once, then continue working. Octo owns polling and returns check completion and actionable failures through the owning agent's durable inbox; the caller does not run a blocking `gh pr checks --watch` loop.

```sh
bin/octo-manager track --url https://github.com/OWNER/REPO/pull/NUMBER --thread-id "$CODEX_THREAD_ID"
```

Every observed head of an enrolled open PR gets a persistent check watch. Each watch has a PR, exact `headSha`, generation number, `state` (`waiting`, `completed`, `superseded`, or `cancelled`), collected check evidence, and millisecond timestamps. Workflow runs are read independently by head SHA so queued workflows without materialized jobs prevent premature completion. The first complete observation can report already-finished checks. Empty check lists, unknown conclusions, pending/running executions, and partial/unavailable source reads remain waiting. Both commit statuses/check runs and workflow coverage must be complete.

When all known executions reach terminal states, Octo retains the result in the persistent check watch. Completed success and neutral/skipped results produce a short, head-pinned completion notice for an open PR. Supersession stays silent. Check conclusions and GitHub conflict status are presented separately; this does not establish approvals or branch-protection eligibility. Failed jobs use the existing `check_failed` action; a failed completed watch creates a `check_results` action only for failures not already represented by a reported job or its workflow run. Successful completion uses the same durable delivery and receipt path, without a failed-run label. Full watch evidence remains available through `tracking --json`. Failed messages follow the [agent message standard](agent-messages.md): a short excerpt and run link, with full evidence available on demand.

Previously observed executions are retained even if a later response omits them. A missing unresolved execution keeps the watch waiting; missing terminal outcomes remain in the result. A positively newer status in the same context or a newer attempt of the same workflow can replace prior evidence. Other missing check-run IDs are retained conservatively. This avoids silently turning disappearing failures into success. New generations require positively observed new, restarted, or changed executions, rather than removal alone. A result is a snapshot of observed executions and cannot predict future runs.

A changed PR head silently supersedes the old watch and starts a watch for the new head. Existing waiting watches continue after the PR closes or merges. Untracking cancels waiting watches and notification delivery while retaining history. A PR with no executions stays waiting until checks appear or tracking is stopped; Octo does not guess that an empty list passed.

The Tracking view shows watches and linked completion details; `tracking --json` exposes typed `checkWatches` alongside actions, deliveries, and receipts. Watches, results, and callback creation commit with observations in SQLite version 8. Restart resumes waiting watches and does not duplicate failures. Queued successful completion survives restart. Superseded-watch actions are retired without rewriting message history; previously retired success notices are not resurrected. The `check_results` execution profile can retain future harness/model preferences; it does not launch a repair agent or change the recipient's settings. Automatic enrollment of every agent-created PR remains separate from this enrolled-PR watch.

New notifications contain actionable evidence without repeated policy or command arrays. The service confirms receipt when the exact immutable body appears as user input in the owning Codex thread; queue admission, assistant echoes, and altered copies do not qualify. This records a host receipt, not model processing or action acceptance/resolution. Explicit receipt and inbox commands remain available for manual recovery. Previously stored messages remain unchanged.

Known bot lifecycle and no-findings summaries remain in observations without creating feedback actions or deliveries; see the [review lifecycle filter](agent-messages.md#review-lifecycle-filtering). Human and inline feedback and unknown provider formats remain eligible.
