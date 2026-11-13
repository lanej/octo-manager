# CLI output for agents

Output format and audience are separate. `--json` explicitly requests the existing JSON result for scripts. An agent session automatically selects JSON and a tighter presentation contract, even without `--json`. Human formatting remains unchanged outside agent mode; piping stdout alone does not identify an agent.

| Selection | Behavior |
| --- | --- |
| `--json` | Compact JSON serialization of the command's ordinary result. It does not disable a detected agent's output limits. |
| `CODEX_THREAD_ID` is nonempty | Automatically use agent output. |
| `--agent` or `OCTO_MANAGER_AGENT=1` | Explicit agent output for another harness or a controlled invocation. |
| `OCTO_MANAGER_AGENT=0` | Disable automatic detection; an explicit `--agent` still wins. Combine with `--json` when a script needs ordinary JSON inside an agent shell. |
| `--full` | Explicit complete JSON inspection for a read-only command. It bypasses the agent projection; it is rejected for mutations before contacting the coordinator. |

Agent responses use the same small envelope across tracking, subscriptions, notifications, activity, submissions and repairs:

```json
{"ok":true,"command":"pr","data":{"pr":{"id":"…","url":"https://github.com/owner/repo/pull/17","enabled":true}},"omittedItems":0,"detailsOmitted":true,"next":"octo-manager 'pr' '…' '--full'"}
```

The presentation includes state, identifiers, short summaries, participant roles and evidence links. Failed refreshes retain their diagnostic, error timestamp and last observation time so stale evidence remains distinguishable; `ok` describes completion of the CLI request, not success of every underlying check or refresh. It excludes stored message bodies, serialized check/review evidence, transport details, execution history and journals. It includes at most eight collection entries across a response, prioritizing action and message collections, and at most 3,000 UTF-8 bytes before the final newline. Larger summaries are shortened; row and detail omissions are explicit. Cursor fields are not copied into the compact projection: callers must not advance a server cursor past locally omitted rows. `next` provides read-only inspection of the same result/page, preserving arguments such as recipient, revision, original cursor, policy version/tier and state. If quoting an unusually long argument would exhaust the budget, the hint instructs the caller to reuse its arguments instead of echoing them. It never asks the caller to repeat a mutation.

Full observations remain in the coordinator. Use an explicit read command with `--full` when the omitted evidence is needed, then use its original pagination contract. A receipt remains a receipt; projection does not accept, reconcile or resolve an action. Byte limits apply after JSON escaping. If a complex record cannot fit, the envelope retains only identifying/status fields or omits the data with `detailsOmitted: true` and a recovery hint. It never silently presents an abbreviated audit history as complete.

Errors in agent mode and explicit JSON invocations are one JSON object on stderr with `ok: false`, the command and a short error message; the exit status remains nonzero. Interactive programs, help text, the long-running server readiness protocol and Codex hook protocol retain their existing interfaces. Agent event queries are bounded; continuous `--watch` requires explicit full inspection.

Receipt commands retain their smaller ordinary contract too: `acknowledge-digest` returns at most 20 current member summaries and 6,000 bytes outside agent mode, while `acknowledge-message` returns only receipt metadata. Agent mode applies the tighter shared budget on top. Detailed inspection and receipt documentation live in [agent digests](agent-digests.md) and [agent messages](agent-messages.md).
