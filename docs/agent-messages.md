# Agent message standard

An unsolicited message must give the receiving agent a decision to make or work to consider. Optimize the initial context for that decision; keep full observations and recovery state in Octo.

## What merits delivery

- Deliver failed checks, conflicts, and new or edited review feedback that needs assessment. Filter known bot lifecycle summaries (queued, running, inconclusive) and completed reviews without findings.
- Deliver one completion notice per completed check-watch generation for an open PR, including successful checks. Keep superseded watches silent.
- Do not send a second completion summary for a job failure already reported. Suppress its corresponding failed workflow summary, while retaining unrelated failures.
- Do not infer new authority from a notification. Standing task authority and evidence-handling rules belong in session/integration setup, once.

Successful completion is actionable as a merge-assessment signal. Report the exact revision and distinguish check conclusions from GitHub conflict status. “Checks passed; no merge conflicts” does not establish required approvals or every branch-protection rule. Repeated observations and restarts do not repeat a completion; newly observed executions can create another watch generation. Completion for an already closed or merged PR stays in history without a readiness notice.

## Initial message

Show the PR, short revision, failed check or other issue, a short evidence excerpt when available, and a direct evidence link. Include a file and line for inline feedback. A grouped result names its first failure and reports the total failure count; the referenced action retains every unreported failure. The message retains short delivery and action IDs for correlation; omit profile/model preferences, JSON evidence dumps, command arrays, acknowledgments, defensive paragraphs, and requested-response boilerplate.

```text
PR #13 · macOS check failed at ad8968bf
> ENOENT: handoff file disappeared during status read
Failed run: https://github.com/lanej/octo-manager/actions/runs/43135409074/job/130909441931
```

A successful completion is shorter: “PR #13 · Checks passed; no merge conflicts at ad8968bf,” with the PR link. Neutral/skipped conclusions are labeled explicitly, and unknown/conflicting GitHub merge status is preserved. Temporary coverage loss does not erase a confirmed completion; positively observed pending/failing executions, a changed revision, or PR closure retire an outdated readiness action.

The renderer budgets 120 UTF-8 bytes for the heading, 480 for the excerpt, 120 for an inline location, and 512 per rendered HTTPS link. Excerpts end with an ellipsis when truncated and are presented as quoted data. Control sequences are removed. These component limits keep the message below 4 KiB; typical messages are substantially smaller. Truncation changes presentation, not the stored action or watch evidence.

For GitHub Actions job failures, the service attempts a read-only failed-log excerpt with a five-second deadline and a 512 KiB process-output limit. It reads only the repository named by the tracked PR. It searches the final 100 log lines for an error and includes up to four lines. A missing, oversized, or unavailable log omits the excerpt while retaining the failed-run link; an excerpt is not a claim of root cause. Other check providers retain their evidence link without an invented error. Agents fetch additional evidence only when needed with `octo-manager action ACTION_ID` or the linked run.

## Delivery, receipts, and replies

Freeze the rendered message before sending and reuse the exact body and delivery ID for retries. The service reconciles the owning Codex thread through the app-server API. Only an exact matching user-message body records a receipt through the ordinary audited acknowledgment operation. A queue ID, echoed marker, assistant quotation, or altered body is insufficient. API/history failure leaves receipt unknown and retains retry/recovery state. Receipt establishes host context delivery; action acceptance, reconciliation, and resolution remain separate.

Keep individual notices free of acknowledgment commands or repeated recovery instructions. A grouped digest carries one exact-revision receipt command as a fallback when native history reconciliation or the optional hook is unavailable. Manual inbox and receipt APIs remain available when automatic reconciliation cannot establish delivery. Optional hook recovery returns the stored body without repeating policy around it. Existing immutable messages are retained as sent. For queue endpoints, the [digest reconciler](agent-digests.md) can withdraw exact managed queue copies while retaining canonical history; it never removes unrelated user messages.

Keep conversational reports to the decision: outcome and necessary next step, usually one to three sentences. A notification should not create a new reporting ceremony.


## Short identifiers

Display action and message UUIDs as eight hexadecimal characters, omitting hyphens. Extend a prefix only when needed to distinguish IDs already stored in the corresponding action/message namespace. Frozen notices keep their chosen spelling; a later collision can make an older short lookup ambiguous, so lookup rejects ambiguity and asks for a longer ID. `octo-manager action SHORT_ID` and message receipt commands accept unique prefixes of at least eight hexadecimal characters. Full UUIDs remain unchanged in database keys, API responses, queue idempotency metadata, and receipt/activity records. Exact-body history matching works with short markers and retains compatibility with older full markers; a short marker alone is never a receipt.


## Review lifecycle filtering

The [categorization engine](categorization.md) routes known GitHub authors to local heuristics and returns a typed category before creating actions or deliveries, while retaining their raw bodies and revisions in observations. Codex connector summaries use their versioned review-state metadata: running/inconclusive/no-findings states stay quiet when neither code nor security review reports findings. Mixed states with findings remain actionable. Copilot clean-review filtering recognizes the observed `ccr-overview-v2` “No open issues” overview and the explicit zero-generated-comments template, plus narrowly recognized lifecycle messages. Human messages, inline review comments, malformed metadata, unknown provider formats, and mixed/contradictory text are retained for assessment; a keyword such as “running” in ordinary feedback is not a filter.

Later edits that contain findings create normal durable feedback actions. A later no-findings edit supersedes the old revision without a new notification. Installation retires previously queued known status-only actions without rewriting message history. Known Codex metadata comments are omitted from actionable excerpts so the preview starts with visible review content. Check completion and merge-assessment notices follow their separate rules above; a review bot's clean summary is not another check-completion callback.


## Participants and bounded receipts

PR ownership and listening are separate. Deliver applicable updates independently to the owner and each subscribed observer; receipt by one agent must not acknowledge another agent's copy. Only the owner can accept or start an action. Observer notices identify their role and current owner. Participant messages show short agent references and human labels rather than transport addresses or full session IDs. Labels and membership do not establish that an agent is online.

Membership changes produce one current roster notification per remaining participant. Superseded roster revisions remain stored but must not be delivered as current context. Show at most eight participants, including the owner and recipient, and provide roster retrieval when others are omitted. Queue endpoints deliver these through existing digests; optional hook recovery and inbox retrieval also expose them. Direct-turn action notices still deliver normally; standalone roster changes use inbox recovery on direct-turn endpoints.

`acknowledge-digest` returns a receipt and compact metadata for that exact revision, including current applicability and recipient role. Its default and JSON output contain at most 20 items and 6,000 bytes before the final newline, with an omitted-item count and an explicit inspection command. If quoting an unusually long state path would exhaust the budget, instruct the caller to reuse its state argument rather than echoing that path. Single-message acknowledgment likewise prints only receipt metadata. Never echo stored message bodies, all revisions, queue transport details or event history merely to acknowledge receipt. Keep full identities in storage and RPCs and use collision-aware short references in CLI presentation. Explicit `digest` inspection retains the selected immutable body and bounded journal history. A stale receipt never makes a superseded item current, and a receipt still does not accept or resolve an action.


Agent CLI calls automatically select the tighter [agent output contract](cli-output.md); `--json` stays available explicitly, and full evidence requires an explicit read-only inspection.

Known Codex status summaries and boilerplate review receipts are informational even when summary metadata says findings exist. Actual finding comments remain eligible for delivery; unfamiliar substantive feedback and inline comments are preserved. On restart, existing informational actions become superseded and pending deliveries are cancelled while raw evidence and receipts remain in history.

Failed-run excerpts use validated job step timings to select failed-step log lines before finding a diagnostic. Fatal runtime diagnostics take precedence over generic error lines, and timestamp prefixes are removed. The final excerpt remains bounded to 480 bytes; missing step timing, ambiguous second-level boundaries or inaccessible logs yield the failed-run link without a guessed excerpt.
