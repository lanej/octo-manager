# Agent message standard

An unsolicited message must give the receiving agent a decision to make or work to consider. Optimize the initial context for that decision; keep full observations and recovery state in Octo.

## What merits delivery

- Deliver failed checks, conflicts, and new or edited review feedback that needs assessment.
- Deliver one completion notice per completed check-watch generation for an open PR, including successful checks. Keep superseded watches silent.
- Do not send a second completion summary for a job failure already reported. Suppress its corresponding failed workflow summary, while retaining unrelated failures.
- Do not infer new authority from a notification. Standing task authority and evidence-handling rules belong in session/integration setup, once.

Successful completion is actionable as a merge-assessment signal. Report the exact revision and distinguish check conclusions from GitHub conflict status. “Checks passed; no merge conflicts” does not establish required approvals or every branch-protection rule. Repeated observations and restarts do not repeat a completion; newly observed executions can create another watch generation. Completion for an already closed or merged PR stays in history without a readiness notice.

## Initial message

Show the PR, short revision, failed check or other issue, a short evidence excerpt when available, and a direct evidence link. Include a file and line for inline feedback. A grouped result names its first failure and reports the total failure count; the referenced action retains every unreported failure. The transport retains a delivery marker and action ID for correlation; omit profile/model preferences, JSON evidence dumps, command arrays, acknowledgments, defensive paragraphs, and requested-response boilerplate.

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

Do not spend recipient context on acknowledgment commands or repeated recovery instructions. Manual inbox and receipt APIs remain available when automatic reconciliation cannot establish delivery. Optional hook recovery returns the stored body without repeating policy around it. Existing immutable messages are retained as sent; installing the new format does not rewrite history or remove text already queued in Codex.

Keep conversational reports to the decision: outcome and necessary next step, usually one to three sentences. A notification should not create a new reporting ceremony.
