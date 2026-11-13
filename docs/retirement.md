# PR monitoring retirement

Octo retires GitHub polling independently of durable notification delivery. A closed PR can finish its existing check watches, then move into history without waiting for its owner to return. Existing message receipts and action progress remain separate.

| State | Meaning |
| --- | --- |
| `watching` | Poll an enrolled PR normally. |
| `draining` | The PR is merged or closed; finish existing watches and obtain a final complete refresh. |
| `archived` | Automatic polling has stopped. Applicable unread notifications remain deliverable. |
| `disabled` | An explicit `untrack` stopped polling and delivery. Notifications cannot resume it. |

The first confirmed closed/merged observation starts a persisted 24-hour deadline. Repeated observations, failed reads and restarts do not extend it. A subsequent complete check/review refresh with no waiting watches archives the PR with reason `settled`. A deadline archives it with reason `deadline`, retains incomplete evidence and expires outstanding watches. Expiry is not a successful or completed GitHub result. Tracking and Activity show the incomplete-results warning. Retirement does not accept or resolve an action; existing applicability rules still supersede obsolete notices and withdraw their queued copies.

The coordinator fences observations by tracking epoch so a delayed response cannot undo manual disabling, retirement or a later enrollment. Explicit tracking resumes an archived/disabled PR under the existing ownership rules. Reopening during draining clears the old deadline; a later closure starts a new cycle. A reopened archived PR gets an appropriate new check-watch generation while prior results remain historical.

## Notification-driven reactivation

One GitHub.com account-wide poller reads notifications through existing `gh` credentials. It includes read threads, preserves GitHub read/unread and subscription settings, uses conditional requests and obeys polling/rate-limit headers. Only already enrolled, automatically archived PRs are candidates. Octo fetches authoritative PR state before resuming monitoring and retains the existing agent owner; an arbitrary notification URL cannot enroll another PR or redirect a read.

Cursors are account-scoped and persisted. Completed scan watermarks advance only after all pages are durably processed. Bounded page batches retain their next page and use an overlap window; thread/update identities deduplicate replay. Refresh requests are persisted with revision fences, survive restart, and retry unavailable PR reads. A conditional `304` does not create work. Access failures are retained and shown in Activity without resetting retirement or flooding repeated identical errors.

This deliberately uses notifications only: there is no daily archive sweep or webhook receiver. Unsubscribed, missing or otherwise unavailable notifications can require explicit retracking. Changing accounts cannot reuse another account's cursor. Current GitHub notification authentication limitations remain visible rather than causing credential or permission changes.

## Persistence and API

Schema 11 adds the tracking enum, epoch, drain deadline, archive timestamp/reason, notification cursors, deduplication identities and pending refreshes. Timestamps remain integer Unix milliseconds. It extends check watches with `expired`; it preserves existing PR, agent, action, message, receipt and watch identities. On migration, enrolled closed PRs receive a fresh drain deadline and refresh; explicitly disabled records stay disabled. The existing API `enabled` field remains the manual-enrollment projection, including archived records, while `tracking_state` determines polling. Generated Go and TypeScript bindings carry retirement metadata and watch expiry.

Back up state before upgrading; older coordinators reject schema 11. No result is inferred from a missing observation or rewritten from an old notification body.
