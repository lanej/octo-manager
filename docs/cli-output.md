# CLI output for agents

Agent mode returns a command-specific subset of ordinary JSON, retaining its object or array shape. It removes bookkeeping and historical payloads while preserving actionable fields and complete result pages. It adds no success envelope, recovery command, or omission counters.

| Selection | Behavior |
| --- | --- |
| `--json` | Compact serialization of the ordinary result outside agent mode; retains the agent projection inside agent mode. |
| Nonempty `CODEX_THREAD_ID` | Automatically selects agent JSON. |
| `--agent` or `OCTO_MANAGER_AGENT=1` | Explicitly selects agent JSON. |
| `OCTO_MANAGER_AGENT=0` | Disables automatic detection; explicit `--agent` still wins. Combine with `--json` for ordinary JSON in an agent shell. |
| `--full` | Complete JSON inspection for a read-only command. Rejected for mutations before contacting the coordinator. |

For example, `pause` returns `{"scheduler":"paused"}`. `pr show ID` retains its `pr` object, ownership, lifecycle, head/base revisions, observation time and refresh diagnostics. `message ID` retains all member identities, applicability and receipts, plus the PR URL, exact head and method of a merge offer. Completed job inspection retains its task and result. An underlying failed refresh remains a diagnostic in a successfully retrieved result; command completion does not establish refresh success or action resolution.

There is no local row allowance or byte budget in agent mode. Every collection retains its complete server-selected page, order, cursor, total and continuation flags. Independent collections cannot consume each other's allowance. Summaries, findings, identifiers and evidence links are not shortened. Integer fields beyond JavaScript’s safe numeric range use decimal strings so cursors remain exact. Existing server response limits and pagination still apply; callers continue using each command's original cursor semantics.

Routine agent output omits transport internals, historical transitions, old assignments/briefs, retained conflict inputs, duplicate serialized evidence and original notification bodies. Current issue briefs retain every criterion and question. Activity and explicitly paged event queries retain the complete selected page. Safe inspection continues to exclude untrusted producer prose where the API requires explicit evidence retrieval; projection does not grant additional access.

Use the same read-only command with `--full` when omitted evidence is needed, preserving the original page and filter arguments. Examples include `issue list --offset 20 --full`, `issue show ID --before 100 --full`, `chain show ID --full`, `dependency list PR --full`, `reference list PR --full`, `conflict show ID --full` and `history policy OWNER/REPO --policy-version 1 --tier routine --full`. Do not repeat a mutation to inspect its result. Inspect a mutation through its corresponding PR, action, chain, receipt or activity read command.

Agent failures write one JSON object to stderr and exit nonzero, leaving stdout empty: `{"error":{"message":"…","code":"…","fix":"…"}}`. Codes and fixes appear only when available. Diagnostics are not shortened. Publication validation includes every finding in the error message. Non-agent output and diagnostics retain their ordinary contracts.

`read ID` retrieves evidence and records delivery for every frozen member. Its agent response strips bookkeeping, profiles, assessment history and duplicated serialized evidence while preserving complete findings, conclusions, applicability, receipts, evidence warnings and separately scoped operator instructions. Use `message ID --full` for complete read-only inspection. Receipt does not accept work, resolve findings or authorize merging.

Compatibility digest receipts retain every returned member with complete identifiers in agent mode. Their non-agent presentation retains its existing bounded contract. Detailed receipt behavior is documented in [agent messages](agent-messages.md) and [agent digests](agent-digests.md).

Help, interactive programs, the server readiness protocol, repository-authored publication instructions and Codex hook output retain their intentional interfaces. Agent event queries are finite; continuous `--watch` requires explicit `--full`. Full event inspection retains its existing newline-delimited event stream.
