# PR listeners

A PR has one responsible owner and any number of observer subscriptions. One agent can listen to multiple PRs, including PRs in different repositories. Ownership determines who may acknowledge or start an action; listening determines who receives updates. This is local coordinator membership, not a GitHub notification subscription or an access grant.

```sh
octo-manager subscribe https://github.com/owner/repo/pull/17 --thread-id THREAD --label "Independent review"
octo-manager participants https://github.com/owner/repo/pull/17
octo-manager participants https://github.com/owner/repo/pull/17 --after 20
octo-manager unsubscribe https://github.com/owner/repo/pull/17 --agent-id AGENT
```

`subscribe` requires an already enrolled, enabled PR. It never silently enrolls a new PR, takes ownership or resumes manual untracking. The owner listens implicitly and cannot unsubscribe without transferring ownership or untracking. Existing records migrate with their owner as the only listener. Repeating the same subscription is a no-op. A new observer receives applicable unfinished actions; unrelated historical or resolved actions are not replayed. Lists return at most 20 participants, their total and `has_more`; `--after` is a participant offset. Use the normal `--state` option for another coordinator.

Every applicable action has a distinct delivery/message for each listener. One recipient's receipt cannot clear another's unread copy, and observer receipt cannot accept the shared action. Unsubscribe cancels only that recipient's copies for that PR. Rejoining creates fresh copies rather than reviving previously cancelled messages. Global `untrack` still disables polling and all delivery; automatic archival retains applicable unread messages. Explicit observer subscriptions survive retirement and owner reassignment. The old owner's implicit membership ends on reassignment unless it also has an explicit observer subscription.

Octo tells current participants about membership and ownership changes with a compact roster: role, human label or harness fallback, and short agent reference. The recipient and owner are always visible; up to eight names fit in the notification, with retrieval for the rest. Only the latest roster revision is applicable. Old immutable messages and receipts remain available as evidence. Availability is unknown unless separately observed; Octo does not start agents, change their settings or infer permission to repair from membership. Queue delivery and hook/inbox recovery carry roster messages; direct-turn action delivery remains available, with standalone roster updates retrieved through recovery or the inbox.

## Data and boundaries

Schema 12 adds the following records. All timestamps remain integer Unix milliseconds. The migration preserves existing PR, action, agent, delivery and receipt identities; older coordinators reject schema 12, so back up state before upgrading.

| Record | Description |
| --- | --- |
| `pr_subscriptions` | Unique `(pr_id, agent_id)` observer membership with creation time and foreign keys. Owner membership derives from the PR record. |
| `pr_participant_revisions` | Monotonic roster revision per PR, advanced transactionally with membership changes. |
| `participant_messages` | Immutable per-recipient roster body and revision, globally sequenced with the inbox, with an independent monotonic receipt. Current membership, enrollment and roster revision determine applicability. |

The tracking capability owns subscription policy, action fanout and roster creation. The inbox owns per-recipient receipt and applicability; the existing digest reconciler owns queue effects and withdrawal. The API adds `SubscribePullRequest`, `UnsubscribePullRequest` and paginated `ListPRParticipants`. Agent targets, action ownership and existing message/digest identities are reused. No model is needed to classify participants or acknowledge a digest.
