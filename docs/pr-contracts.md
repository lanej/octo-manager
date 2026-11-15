# Executable PR contracts

Octo prepares a description, independently evaluates it, and publishes only a valid, unchanged result. It supports new PRs, fork heads, and replacement descriptions for existing open PRs. A valid result means the configured checks and evaluator passed against captured evidence; semantic evaluation remains model judgment.

## Repository configuration

Author `octo-manager.toml` at the target repository root, separately from the installed Octo binary and generated operation state. Publication reads the file from the target base commit. A PR changing this file does not silently weaken its own requirements. `--config PATH` supplies an explicit local override; its text and effective settings become part of the preparation.

See the [complete default example](../examples/pr-contract/octo-manager.toml). Partial tables override versioned defaults. `schema_version = 1` is mandatory; unknown keys, unsupported versions, invalid thresholds, and duplicate overrides fail. Operations never rewrite authored configuration or execute commands from it.

```sh
octo-manager config validate
octo-manager config explain --config ./octo-manager.toml --json --full
```

Explain reports each effective value and its source. Contribution guidance and templates remain source-cited inputs. F-pattern scanning is the default: outcome and problem first, meaningful opening words, reader-priority ordering, and headings only for navigation. An explicit repository template takes precedence over the default layout.

Deliberate departures from discovered rules require a policy rule ID and reason:

```toml
[[pr.overrides]]
rule_id = "avoid-llm-description"
reason = "Generate concise, problem-focused prose with independent evaluation; this deliberately departs from the literal authorship instruction."
```

The original instruction and exception remain recorded. This does not establish compliance with the overridden instruction. Private GitHub context cannot enter public-target analysis unless caller-supplied configuration explicitly records a `context.private-to-public` override and disclosure reason. Target-repository configuration cannot grant this authority.

## Prepare, validate, publish

The existing [intent schema](../schemas/pr-intent.v1.schema.json) gains optional `problem`, `outcome`, `headRepository`, `references`, `updateUrl`, structured `contract`/`contractSource`, and supplied `description` (`title` and `body`). Existing required fields remain request ID, repository, head ref/SHA, base ref, purpose, validation, draft flag, and owner. Changed facts require a new request ID. GitHub references resolve supplied issues/PRs as context without recursive crawling or automatic merge dependencies.

```sh
octo-manager pr prepare --input change.json
octo-manager pr validate --input change.json --description-file pr.md --title 'fix: retain selection'
octo-manager submission OPERATION_ID --full
octo-manager pr publish OPERATION_ID
```

Prepare invokes the writer; validate preserves supplied prose and skips it. Both run the independent evaluator. These CLI commands wait for a terminal decision by default and return a failing exit code for rejection; `--no-wait` returns the durable operation immediately. Publication is separate. Existing `submit-pr` still publishes automatically through the same gates.

For updates, set `updateUrl` and supply its current base and head repository/ref/SHA. The existing description becomes context for a complete replacement. Preflight refuses observed edits to title, body, head, or base. This is not atomic protection: a collaborator can edit between preflight and write. Octo checks saved remote identity and bytes afterward; changed or unconfirmed results remain uncertain for reconciliation.

## Scoring and presentation

Each complexity factor receives a 0 (absent), 1 (localized), or 2 (substantial/cross-cutting) rating, rationale, and evidence. Default weights for breadth, behavior, coupling, compatibility, and state/operational risk are 1, 2, 2, 3, and 3. The coordinator computes the score: routine 0–4, standard 5–11, complex 12–22.

Default prose maxima are 100, 250, and 600 words; there are no minimums. Prose and table text count; fenced code and diagram syntax do not. Descriptions over 150 prose words must introduce an explanatory artifact by word 150. Complex descriptions require source-backed Mermaid. The evaluator checks artifact usefulness; decorative code or diagrams do not establish compliance.

GitHub diff context is capped at 512 KiB. Exceeding that bound currently blocks preparation before optional PR Flow capture; large generated binding updates can reach it even when their authored source is small. Generated patches are not automatically collapsed or silently omitted.

PR Flow provides exact-commit declarations, relationships, HTTP candidates, coverage, and diagnostics through `analyze-refs`. Install it on the coordinator PATH or select a trusted executable through `OCTO_PR_FLOW`. Oversized full captures fall back to an explicitly marked changed-files-only capture, retaining the complete captured failure message, stdout, stderr, and termination metadata (subprocess output is bounded to 1 MiB per stream). Compact node, edge, and HTTP-candidate queries bound model context and validate the capture digest. Changed-file scope bounds graph extraction; PR Flow still enforces its 20 MB source-acquisition limit before filtering. Missing coverage is explicit; adequate alternate diff or supplied evidence can satisfy a decision. Missing analysis must not imply low complexity, and static candidates do not prove runtime execution.

The pinned Mermaid parser validates syntax. Actual rendered appearance remains separate. Markdown and HTML images require public HTTPS image content; addresses are checked and pinned, redirects and downloads bounded, and content hashes rechecked before publication. Octo does not host images.

Issue/PR references render as plain `#123` within the target repository and `owner/repo#123` elsewhere, without backticks or Markdown links. Targets must resolve in captured context. Closing keywords require the same explicit resolution relationship in caller purpose.

Decisions distinguish `invalid` from `needs_evidence`; both block publication. Contract, Git/context snapshot, draft, evaluation, image hashes, and title/body bytes are bound by a preparation digest. Changed inputs require fresh evaluation. Policy discovery works without a changed branch. Citation failures retain raw output and can be retried.

## Typed API and configuration provenance

Exported JSON Schemas describe CLI intent files and views; generated protobuf messages define the wire shapes, including presence wrappers and assessment variants. Submission RPCs carry typed protobuf messages for intent, preparation, contribution policy, decisions, and operation state. Requirement checks and worker assessments use declared variants. `google.protobuf.Value` is limited to malformed worker evidence and heterogeneous PR Flow graph records; coverage and operation metadata have typed fields. Presence-bearing list messages distinguish absent lists from explicit empty lists, and optional scalars retain false and zero values. Runtime domain validation still enforces constraints beyond protobuf field types.

The CLI parses `--config` TOML before submission and sends structured `contract` settings with `contractSource` metadata: the original source SHA256, selected path, authored setting paths, and Git blob identity when repository-discovered. Authored paths distinguish selected settings from versioned defaults. Caller-selected and repository-discovered configuration stay in separate input/snapshot containers; source labels cannot grant disclosure authority. Raw source SHA256, Git blob identity, and the effective contract bound into a preparation establish different facts.

Public intent, brief, and submission schemas omit raw `contractToml`. Historical durable records keep their original text and hash material; response projection exposes parsed contents and source provenance without rewriting those records. Invalid historical TOML remains readable with a parse error and source digest. Live imports parse configuration strictly; malformed legacy input, mixed legacy/structured configuration, and source metadata without parsed contents are rejected before submission. Protobuf JSON-string field numbers and names are reserved rather than reused. This is an intentional wire-breaking change: upgrade and restart the CLI and coordinator together. Requests lacking the new typed input fail with an explicit upgrade error.
