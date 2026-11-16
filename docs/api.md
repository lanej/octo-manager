# Local API

The Bun coordinator serves the generated `octomanager.v2` Connect API over its Unix socket. The CLI and Charmed Go dashboard use the generated clients. `GetServerInfo` reports the protocol version; clients check it before requests or dashboard streaming and report incompatible server/client installations clearly. Install the coordinator, CLI, and dashboard together. The v1 service is not served.

RPC records use explicit Protobuf messages, enums, and variants for check/review coverage, feedback, delivery progress and outcomes, merge policy and results, frozen messages and receipts, and archived submissions and policies. Domain records are not serialized inside string or bytes fields, and the API has no `Struct`, `Value`, or `Any` escape hatch. Markdown, logs, and original worker output remain source text. Invalid archived worker results retain their raw source and an explicit invalid-result marker.

Merge operations have dedicated requests and responses. JSON intent files remain local CLI input where appropriate; they are validated and translated into typed requests. CLI JSON output is a presentation format rather than a serialized document nested in an API field. Database JSON serialization remains an internal storage detail.

`bun run generate` exports the domain contract messages, runs Protobuf lint, and regenerates TypeScript and Go bindings. `proto/api-wire-tags.json` preserves field, enum, and variant numbers across property reordering and additive edits; removed tags remain reserved and incompatible type changes require a protocol version change. Generated domain conversion metadata is committed alongside the bindings. Code-generation drift is checked in CI.

Observation variants preserve complete-empty, partial, and unavailable evidence separately. Receipt records preserve exact frozen membership and timestamps; acknowledgment does not accept work, resolve a blocker, or authorize a merge. Diagnostic journal fields have explicit types; unsupported historical fields are identified in `omittedFields`, and the original journal remains stored.

Legacy drafting and publication execution RPCs are retired. Typed historical reads remain available. The scheduler reconciles legacy publishing, enrolling, and uncertain records only when they retain a saved publication brief. It uses the shared GitHub dispatcher, verifies a unique existing marker and the saved head/repository/open state, and enrolls only confirmed matches. Missing or ambiguous matches remain uncertain. Recovery deadlines are persisted before lookup, using delays of one, five, and fifteen minutes, then hourly; longer provider cooldowns still apply. Recovery never invokes a worker or creates a PR.

## Issue lifecycle API

`EnrollIssue` authorizes investigation for a provider-qualified issue in a verified local checkout. `UpdateIssue` records brief-version approvals, publication/follow-up approvals, answers, pause/resume/cancel, and refresh requests. These responses confirm durable decisions, not agent execution or remote effects. `ListIssues` returns twenty summaries per offset page; `GetIssue` returns current state, the latest ten briefs, ten assignments, twenty pending effects, and fifty events. `before_sequence` pages events only. Snapshots include up to fifty issue summaries and latest assignment details for the dashboard.

`IssueStage` and `IssueWaiting` are separate enums. Assignment identity and observations preserve current harness/session/turn information; effect status and URLs retain reconciliation evidence. See [issue state machines](issue-flows.md) for transition prerequisites, current inspection limits, and why Done, terminal agent execution, and tracker closure are different facts.
