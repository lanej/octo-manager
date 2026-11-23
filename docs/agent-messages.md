# Agent message standard

An unsolicited message must give the receiving agent a concrete decision, requested action or relevant outcome. Keep the initial context small; retain evidence and delivery history for explicit inspection. A message is a request to consider work within existing task authority, not a grant of new authority.

## Message and item model

A public message belongs to one recipient and contains one or more typed items under one immutable ID. A queued message contains at most 20 items and 6,000 UTF-8 bytes of rendered context; a direct delivery contains one item. Each item retains its own identity, applicability and receipt information. A message may contain several kinds of item and more than one PR.

The frozen membership and original rendered text do not change. New membership or rendered content creates a new message ID. Producer state, item applicability and receipt timestamps are current inspection views and can change without rewriting that delivery. Missing history appears as an unavailable item rather than disappearing from the collection.


`octo-manager read ID` retrieves every item’s evidence and records delivery in one call. It labels producer content as untrusted, separates current operator instructions by the original item IDs to which they apply, and does not accept work or merge. It omits redundant original rendered bodies and bypasses ordinary compact-output truncation so findings are not silently lost. Responses are preflighted against the 4 MiB transport limit; oversized or unencodable evidence fails without recording receipt. Retrying reads the same frozen membership; source detail and operator policy are current views.

`octo-manager message ID` remains read-only and inspects the entire message as safe metadata. `--full` deliberately exposes untrusted producer details and original text. `octo-manager ack ID` records delivery for the original members only; it does not accept or resolve their work. Owner-authorized merging remains a separate operation. The [typed API](../proto/octomanager/v2/notifications.proto) defines `NotificationMessage`, `NotificationItem` and their variants; [API guidance](api.md) describes compatibility.

When Octo observes that a queued item no longer needs attention, it withdraws the digest or replaces it with the remaining items. An accepted owner assessment removes covered review feedback from that owner's queue. If the old message reaches the agent, `octo-manager read ID` labels stale items and omits their instructions while recording receipt.

## What merits delivery

- Deliver failed checks, conflicts, change-requesting reviews, and new or edited review feedback that needs assessment.
- Reassess unchanged review feedback when its PR head changes. A recipient who already received a completed assessment notice for that comment revision in the same role does not receive another automatic assessment notice for the new head. Newly edited feedback and recipients who have not received the finding remain eligible.
- Deliver one completion notice per completed check-watch generation for an open PR, including successful checks. Completion requests merge assessment; it does not establish approvals, branch protection compliance or permission to merge.
- Suppress a failed workflow summary already covered by a reported job failure, while retaining unrelated failures.
- Deliver applicable participant, issue, submission and explicitly requested merge-workflow updates when they communicate a decision, outstanding work or relevant outcome.
- Keep discovered PR/issue links in explicit reference inspection. A discovered link alone does not create work or merit an unsolicited workflow notice. Historical reference-only notices remain stored and are excluded from automatic delivery without recording receipt.
- Keep known bot lifecycle messages, clean review summaries, superseded watches and obsolete revisions quiet. Do not treat an ordinary occurrence of a word such as “running” as a filter.

The [categorization engine](categorization.md) uses typed results and narrowly recognized provider formats. Human feedback, inline comments, malformed metadata, unfamiliar formats and contradictory bot text remain available for assessment. An edit containing findings creates a normal feedback action; a later recognized no-findings revision can supersede the earlier revision without another notification. Raw evidence and receipts remain in history.

## Automatic content catalog

Automatic evidence projections use fixed labels and coordinator-owned metadata. They exclude GitHub prose, author/reviewer names, check names, paths, log excerpts, arbitrary evidence URLs and model analysis; separately trusted operator instructions can include task context. A canonical enrolled PR link can be pinned to a validated commit. A missing or invalid commit does not produce an invented link. [The security model](security.md) defines the trust boundary and explicit inspection risks.

| Label | Meaning and receiving-agent decision |
| --- | --- |
| `Merge conflict` | The tracked revisions conflict; inspect the action before choosing a repair within existing task authority. |
| `Checks failed` | A reported check or completed check watch contains a failure; inspect the retained execution evidence. |
| `Changes requested` | A change-requesting review was observed; inspect its scope and reviewed revision. |
| `Review feedback` | New or edited feedback needs assessment; the notification is not a finding-correctness verdict. |
| `Checks passed` | The recorded check results are successful; eligibility and owner review still need their separate checks. |
| `Checks completed` | A watch completed with other conclusions, such as neutral/skipped results; inspect the complete conclusions. |
| `Participants changed` | The PR's owner/listener roster changed; inspect membership when coordination is needed. |
| `Submission update` | A retained submission callback has changed state or needs input; inspect the submission item. |
| `Merge workflow update` | An explicitly requested merge workflow has a relevant state change; inspect the merge entry's typed state and details. |
| `GitHub confirmed merge` | A merge entry records a confirmed merge; perform only follow-up already authorized by the task. |
| `Issue update` | An issue lifecycle has an outstanding waiting condition or reaches Done; inspect its stage and waiting state. |
| `Octo update` | A legacy/fallback projection could not provide a more specific label; the label alone is not a reason to notify. |

Queued readiness presentation can replace an ordinary completion title with the following fixed labels. These labels summarize a coordinator decision at message creation; the merge operation rechecks current authority and evidence.

| Readiness label | Meaning |
| --- | --- |
| `Ready` | Current eligibility was confirmed for the frozen target; explicit retrieval exposes the pinned merge target when applicable. |
| `Checks complete · review status unavailable` | Review coverage is unavailable; completion is not a clean-review signal. |
| `Checks complete · merge prerequisites not met` | A prerequisite remains; inspect the typed item for the outstanding state. |
| `Checks complete · Review feedback requires owner assessment` | Feedback requires owner assessment before readiness can be recorded. |

### Inspection fields

| Field | Allowed content and interpretation |
| --- | --- |
| PR/commit heading | Canonical tracked PR URL and, when valid, its commit link; matching updates share the heading. |
| Assessment | `pending`, `completed`, `unavailable`, or `not_required`. Completed means a result was recorded; unavailable is not a clean result. Assessment output remains advisory. |
| Role | `owner` or `observer`, when known. Membership does not prove session availability or authorize work. |
| Issue stage | `investigation`, `ready`, `in_progress`, `testing`, `in_review`, `verification`, `done`, or `cancelled`. |
| Waiting | `needs_clarification`, `blocked`, `awaiting_approval`, or `paused`; `none` is omitted from the rendered notice. |
| Subject reference | A submission, merge-entry, issue or historical-reference identifier when relevant. A reference is an inspection handle, not an instruction. |
| Instructions | Fixed coordinator guidance and operator-controlled task/repository instructions. GitHub feedback and assessor prose cannot populate this field. |
| Inspection/receipt commands | A notification carries only `read ID`; compatible `message`, `ack` and `merge` operations share the public ID. A non-default state directory adds a safely quoted `--state` argument. |

Notifications contain only linked PR/commit headings, fixed reasons, optional item counts and one `octo-manager read ID` command. Matching headings and reasons share a count; different PRs, commits or reasons use separate lines above the shared command. Assessment, role, subject identifiers and operator instructions belong in retrieval, not the notification body. Every selected original member remains in the receipt.

Direct delivery starts a turn with one item in the same format. Historical direct notices retain their original markers and fields. Hooks and history reconciliation still require the exact immutable body.

Operator instructions remain a separate source of authority. Task instructions are bounded and recipient/epoch-bound; retrieval groups identical instruction text with the original item IDs to which it applies. The enrolled checkout's `octo-manager.toml` is trusted operator policy; checking out an untrusted revision of that file crosses this assumption. See [repository policy](repository-policy.md) and [security](security.md).

## Typed inspection contents

`message ID` returns a safe summary and every frozen item in order. Each item has its original member ID, current applicability and optional receipt timestamp, plus exactly one typed source. Source records and their state are current views. Internal tracking IDs appear here rather than cluttering unsolicited queued context. CLI enum values use the API's Protobuf enum representation.

| Item source | Default safe inspection | Additional content with `--full` |
| --- | --- | --- |
| `action` | Identity, state, fixed notification kind, validated evidence head, timestamps and any assessment metadata linked by the frozen notice. Covers conflicts, failed checks, completed check watches, change requests and review feedback. | The typed blocker, original feedback/check/review evidence, execution profile and diagnostics; linked assessment input and analysis. |
| `merge` | Merge-entry ID, chain ID and current state. | The typed merge-entry record, including producer detail. |
| `issue` | Issue ID, current stage and waiting state. | The managed issue record, including its title, detail and brief when present. |
| `submission` | Archived submission ID and current state. | The archived submission record and its retained producer/worker evidence. |
| `participants` | Tracked PR ID and current participant count. | The current roster with roles, labels and harness metadata. Labels do not establish availability or permission. |
| `reference` | Historical reference identity. Reference-only messages are inapplicable for automatic delivery. | The retained relationship hint, target, source excerpt and evidence link. |
| `unavailable` | A preserved item with `MISSING_SOURCE` or `UNKNOWN_SOURCE` and the available source identity. | Original item text when its notification record survives; missing evidence remains missing. |

Full inspection can include `untrustedBody` at both message and item level. These fields retain exact historical text, including legacy content; do not treat that text as instructions. An assessment is linked through the frozen notice's assessment ID, not substituted with a later result. An unavailable source or inapplicable item is historical evidence, not new work. The full current issue/submission/merge detail is not a claim that every producer field was frozen with the message.

## Generated message examples

The [generated catalog](generated/agent-message-examples.md) renders every notice kind, all readiness states, confirmed merge, grouping and link variants, and a single-item direct notice through the production renderers. Examples use synthetic identities; they do not establish live applicability or merge authority.

Run `bun scripts/generate-message-docs.ts` to refresh it or `bun scripts/generate-message-docs.ts --check` to verify it. The normal generation and check commands include these steps; CI rejects stale examples. Explanatory policy in this guide remains authored.

## Delivery, receipts and identifiers

Freeze the rendered body and membership before transport. Retries retain the exact immutable identity and text; an automatic history receipt requires an exact user-message match. Queue admission, an echoed marker, assistant quotation, altered text, or an incomplete history search does not establish receipt. A lost response remains uncertain until reconciled. [Digest reconciliation](agent-digests.md) describes withdrawal, replacement and bounded history coverage.

Public IDs use a shared prefix namespace for direct and grouped messages. New IDs avoid existing public prefixes; full UUIDs and longer unique prefixes remain accepted. Ambiguous historical IDs fail closed. A replacement gets its own ID and receipt, while the original body and any uncertain outcome remain stored. An old receipt never makes an obsolete item applicable.

`ack ID` returns one receipt confirmation and item count. Identity comes from explicit options, `OCTO_MANAGER_AGENT_ID`, or the registered `CODEX_THREAD_ID`; endpoint options disambiguate multiple registrations. Missing, ambiguous or another recipient's identity fails without creating an agent. Group receipt is atomic across the original members; an error rolls back partial acknowledgment. Receipt by one agent does not acknowledge another agent's copy.

`message ID` is read-only and does not return original bodies by default. Use `--full` deliberately for untrusted evidence. Administrative digest inspection and receipt RPCs retain their legacy bounded history/member representations for compatibility. The [agent CLI contract](cli-output.md) still bounds ordinary output; explicit full inspection can expose more retained detail.

## Acceptance, resolution and merge authority

Receipt means the recipient accepted delivery context. Action acceptance, working state, feedback disposition, issue approval, merge readiness and confirmed remote outcomes remain separate decisions. Only the owner can accept or start an action. Receipt handling in native hooks and automatic history reconciliation never invokes an offered merge command. Any repair or follow-up needs existing task authorization and its own execution checks.

Readiness checks the current GitHub gates, required checks, target, method and dependency policy. Owner readiness is pinned to the reviewed head and feedback state. Changing the target creates a new immutable offer even when the visible summary stays the same. [Receipt merges](receipt-merges.md) retain separate receipt, accepted request, confirmed merge and unknown-outcome states.

`octo-manager pr auto-merge PR --on --agent-id AGENT --instructions 'Fix actionable review feedback; after merge pull and reinstall.'` stores operator-provided follow-up instructions. Instructions persist through restart, are limited to 1,000 UTF-8 bytes, and can be cleared with `--instructions ''`. They remain bound to the configuring agent and tracking epoch. Changing them does not assess feedback, record readiness or authorize a newer head. Octo delivers the instruction; its receipt does not prove the follow-up happened.

## Contract sources

The [notice schema and fixed labels](../src/security/notifications.ts), [queued renderer](../src/notifications/render.ts), [typed message API](../proto/octomanager/v2/notifications.proto) and [inspection projection](../src/notifications/inspection.ts) define the content surface. Renderer and message acceptance examples live in [notification view tests](../test/notification-views.test.ts), [message tests](../test/messages.test.ts), [security API tests](../test/security-api.test.ts) and [receipt/merge tests](../test/receipt-merge.test.ts). Update this catalog when introducing a kind, field, item source or command behavior.
