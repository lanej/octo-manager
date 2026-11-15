# Queued agent digests

Queue reconciliation runs only when an agent has applicable unread messages, a live digest, pending digest cleanup, or historical inbox messages outside digest membership that may still have legacy queue entries. Successful idle legacy cleanup is reinspected once per minute to catch late native admission; local membership, receipt, applicability, or transport changes can trigger an earlier inspection. Repeated failures retain their first error event and retry with delays of 5, 10, 20, 40, and at most 60 seconds. Error events include the agent identity and actual rejection. Sessions with no inbox or digest work are not polled.

Queue-mode Codex endpoints receive one pending digest per agent. PR feedback and optional submission callbacks share this delivery path; publication remains opt-in. Individual inbox messages and their evidence remain immutable. The digest groups current applicable unread items by PR, preserving separate findings, a short excerpt and the failed-run or review link. Each revision fits 20 items and 6,000 UTF-8 bytes; unread overflow advances after receipt.

Identical displayed entries within a PR share one line. Submission notices asking for applicability verification share one request with distinct rule IDs listed once. These are presentation groups: every selected original message remains an immutable receipt member, and distinct evidence links remain visible.

## Replacement and cancellation

Octo freezes a revision before transport access. When membership changes, it withdraws the old queue entry, requires `deleted: true`, rechecks current applicability, then admits the replacement with a fresh dispatch UUID. It does not use in-place queue updates. An empty digest is withdrawn without replacement. Queue withdrawal never acknowledges a notification or resolves an action.

A consumed entry (`deleted: false`), lost response or interrupted operation leaves an uncertain journal entry. Octo first reconciles exact user-message bodies in thread history. A positive match receipts only that immutable revision; assistant echoes and copied markers do not count. Unconfirmed withdrawal blocks replacement, including across older terminal digests. If deletion took effect but its response was lost and no positive receipt exists, automatic delivery stays paused; inspect the digest and native queue before recording a manual receipt. Do not invent receipt merely to unblock delivery.

Cleanup retains its original socket independently of current endpoint settings. Changing or removing an endpoint cannot silently abandon a known queued digest. Direct-turn delivery resumes after pending old-queue cleanup. A missing endpoint never falls back to a different socket.

Octo identifies managed entries by owning agent, persisted socket, full immutable dispatch UUID and exact body. Unrelated entries and observed client edits are preserved. Codex's delete API accepts only a queue ID, without an expected-body/version compare-and-swap: an external edit after inspection can race deletion. This is an upstream API limit. Octo never interrupts a running turn; already delivered context cannot be withdrawn.

Queue inspection fails closed after 1,000 entries or invalid pagination. Receipt search examines at most 200 turns and preserves incomplete coverage as uncertainty. Unknown withdrawal outcomes prevent replacement even when bounded history contains no match. Admission without a pending entry or positive receipt can be retried only after complete inspection and no outstanding withdrawal; delivery remains at least once, not exactly-once agent execution.

## Durable data

SQLite schema 10 adds four tables within the existing coordinator database. Timestamps remain integer Unix milliseconds; local timezone conversion belongs to presentation. Opening schema 9 migrates transactionally; older coordinators reject schema 10. Preserve a database backup before downgrading.

| Record | Description and invariants |
| --- | --- |
| `agent_digests` | Mutable delivery envelope: full UUID, agent reference, pinned socket, enum state, current revision, cleanup-pending flag, deadlines and diagnostic. One nonterminal envelope per agent, enforced by a partial unique index. |
| `agent_digest_revisions` | Immutable `(digest_id, revision)` record containing a unique dispatch UUID, exact rendered body and ordered, unique canonical message IDs. New content creates another revision. |
| `agent_digest_receipts` | Immutable `(digest_id, revision)` receipt with agent and millisecond timestamp. A coordinator transaction receipts every member and the revision together; failure rolls all back. |
| `agent_digest_events` | Append-only operation journal: agent, optional digest, millisecond timestamp, kind and structured detail. Started, confirmed, uncertain and reconciled effects remain distinguishable. |

| State | Meaning |
| --- | --- |
| `ready` | A durable snapshot awaits queue admission. |
| `enqueueing` | Admission was journaled before the native request. |
| `queued` | Native admission or queue inspection confirmed a pending entry; receipt is outstanding. |
| `withdrawing` | Withdrawal was journaled before the native request. |
| `uncertain` | Acceptance, withdrawal or receipt cannot yet be established. |
| `unavailable` | Queue inspection/admission cannot currently start; the diagnostic and retry deadline remain visible. |
| `received` | An exact revision receipt was recorded; remaining members can form a new digest after cleanup. |
| `cancelled` | No applicable delivery remains on this transport. This is not a receipt or action resolution. |

The notification capability owns these records and transport reconciliation. Producers continue to own action applicability and immutable canonical messages; they delegate queue delivery rather than sending separately. Existing direct-turn behavior stays available. The API exposes inspection, listing and exact-revision receipt, without giving agents direct database access.

## Inspection and receipt

Agent-facing messages carry one opaque ID for their exact frozen content, without a digest marker, revision, update count or recipient ID. A PR with one update uses a single line; multiple updates for that PR use bullets. The footer is one bare, copyable command:

```sh
octo-manager merge RECEIPT_ID # One Ready notice, current owner only.
octo-manager ack RECEIPT_ID   # Receipt without merging.
octo-manager message RECEIPT_ID
```

`ack` resolves `OCTO_MANAGER_AGENT_ID`, or the registered session identified by `CODEX_THREAD_ID`. Explicit `--agent-id` overrides environment identity. Use `OCTO_MANAGER_ENDPOINT` or `--endpoint` when the same session has multiple registered endpoints. Missing, unknown or ambiguous identity fails; receipt never creates an agent. Each receipt ID resolves to one immutable dispatch, including after replacement or restart. An additive prefix index supports lookup without rewriting old records. New dispatches reserve historically unused eight-character prefixes; ambiguous older IDs require a longer prefix.

Administrative inspection exposes the internal envelope and revision:

```sh
octo-manager messages list --agent-id AGENT_ID
octo-manager messages inspect DIGEST_ID --revision 2
octo-manager action ack-digest DIGEST_ID --revision 2 --agent-id AGENT_ID
```

Use `--state DIRECTORY` for an alternate coordinator. Short unique digest and receipt-agent prefixes are accepted; ambiguous prefixes fail. Agent-facing receipt commands use the opaque dispatch ID and infer the recipient. Inspection returns the selected immutable revision, revision numbers, receipts and the latest 100 journal events. The complete journal remains stored. `GetAgentDigest`, `ListAgentDigests` and `AcknowledgeAgentDigest` are generated Connect RPCs; receipt can require `expected_body` and returns each member's current applicability. Treat obsolete members as historical evidence, not new work.

The optional Codex hook acknowledges an exact incoming digest body before unread recovery. Automatic native history reconciliation also works without hooks. Neither path accepts or resolves the underlying actions. There is no model call, new agent session, setting change or mandatory PR submission in this path.


Acknowledgment output is deliberately smaller than inspection: `record_json` contains only the digest identity, acknowledged/current revisions, recipient and receipt timestamp. At most 20 member summaries carry current applicability, PR link, owner reference and recipient role; no stored bodies or journal events are returned. The CLI applies the stricter 6,000-byte presentation budget, reports omissions and supplies a state-aware inspection command. Callers that need audit history must explicitly use `GetAgentDigest` or `digest`.

PR listeners are described in [subscriptions](subscriptions.md). Participant roster updates share the existing per-agent digest and its withdraw-before-replace protocol, with separate receipt records for each recipient.

Merged PRs supersede outstanding actions and withdraw their queued notifications; immutable check snapshots, messages and receipts remain available as history. Startup reconciles existing actions against cached merged observations without a GitHub request. Closed, unmerged PRs still deliver final check failures while draining.


A frozen revision can contain a validated merge target: PR, owner, tracking epoch, exact head, merge method, action, evidence-context and policy fingerprints. It is included only when the selected members contain one unambiguous owner Ready target. Changing that target creates another immutable dispatch even if the visible summary stays the same. [Receipt merges](receipt-merges.md) preserve separate receipt and merge outcomes; the public ID remains sufficient for either command.
