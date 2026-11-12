# PR submission

Octo accepts purpose and observed validation from a calling Codex session, drafts through isolated Pi workers, publishes a new PR, then enrolls tracking to that session. Both public and private repositories are supported without allowlists. Existing PR edits remain outside this first submission workflow. The caller commits and pushes first; Octo does not change the source branch.

Use `submit-pr --intent-file FILE`. [The intent schema](../schemas/pr-intent.v1.schema.json) defines the request, including a stable request ID, repository, pushed head SHA and refs, purpose, validation, draft status, and caller target. Repeating a request ID with identical input returns its existing operation; changed facts require a new request ID. `submit-pr --purpose 'Problem and intended outcome' --thread-id SESSION` derives repository and branch facts from the current checkout. The paired dotfiles hook supplies session identity and working directory.

`submission ID` retrieves the durable record, `submissions` lists operations, `retry-submission ID` reconciles failed or uncertain work, and `cancel-submission ID` stops work before a publication draft has entered recovery. A `needs_input` result requires a new request with corrected facts. Cancellation after publication may have begun is refused: retry reconciles the external effect instead. Success requires both publication and saved ownership/tracking, with the PR URL persisted before enrollment. Coordinator interruption never implies a remote create failed.

## Contribution policy and PR brief

Octo discovers base-revision AGENTS, CONTRIBUTING, PR templates, and linked local Markdown guidance, preserving source paths, blob SHAs, text and citations. Discovery has file-count and byte bounds; truncated trees, incomplete compare coverage and oversized inputs fail clearly. Relevant source hashes and explicit schema/analyst/stock versions identify reusable policy inputs. Ordinary commits do not invalidate policy. A complete discovery with no guidance uses the stock policy directly.

On a policy miss, a contribution analyst and change analyst run concurrently. On a hit, only the change analyst runs before the dedicated GitHub PR writer. Workers have one model turn, a deadline, no tools or extensions, and use the existing Pi/Codex authentication. Caller-reported validation remains reported. Change claims retain evidence references and a way to falsify each claim. No worker can publish: only the coordinator holds that capability.

The [policy schema](../schemas/repository-pr-policy.v1.schema.json) captures immutable versioned requirements, source citations, required/recommended strength, category, directory scope and declarative or semantic checks. Unsupported semantic requirements need an explicit writer assessment. Exact quotes that occur uniquely in their source are deterministically anchored to the actual line; raw analyst output and reported-to-verified line corrections are both retained. Missing quotes, ambiguous invalid anchors, required-rule failures and writer blockers stop publication. Semantic assessment remains model judgment, not a formal proof. [PR briefs](../schemas/pr-brief.v1.schema.json) pin policy and base revisions and retain change analysis plus title/body. [Submission records](../schemas/pr-submission.v1.schema.json) retain worker results and prompt digests, publication state, URL and enrollment identity. `bun run generate` regenerates these JSON Schemas from the same TypeBox definitions used for runtime validation and TypeScript types.

Policy artifacts include structured `complexityProfiles` with guidance, word ranges and an explicit advisory flag. Older version-1 policy records resolve these from their pinned stock policy without rewriting historical storage. The stock description leads with outcome and why, adding examples, compatibility, limitations and rollout details when useful. Risk and semantic scope determine complexity alongside size. Advisory word ranges are routine 20–100, standard 100–250 and complex 250–600; they never justify padding or dropping required information. Empty sections and duplicate automated check inventories are omitted.

Inspect cached policy with `repo-policy get --repo owner/repo [--version N]`; render its template with `repo-policy template --repo owner/repo --tier routine|standard|complex`. `repo-policy refresh` from a pushed change branch queues a policy-only operation and stores a new immutable version without publishing a PR.

Model roles are independently configurable in the existing config; harness adaptation stays behind the stage-runner boundary. These settings do not change the calling thread's model.

```json
{"submissionModels":{"policy":"gpt-6.1-terra","change":"gpt-6.1-terra","writer":"gpt-6.1-terra"}}
```

## Publication and notifications

States are `queued`, `analyzing`, `writing`, `publishing`, `enrolling`, `succeeded`, `needs_input`, `failed`, `uncertain` and `cancelled`. SQLite schema 9 adds immutable repository policy versions, durable submissions and operation notifications. Times remain integer epoch milliseconds. Existing schema-8 databases migrate on coordinator startup; older binaries cannot reopen the upgraded database.

Before publication, Octo verifies the frozen head and base refs. An immutable hidden submission marker lets a retry find a created PR after a lost response. Retries reuse completed worker results and never overwrite an unrelated existing PR. A created PR with changed identity stays uncertain for inspection. Publication and enrollment are separate saved steps.

Terminal outcomes enter the same caller inbox as PR notifications, with a shared monotonic sequence and exact-body receipt contract. Busy sessions defer delivery. Admission to an app-server queue remains distinct from receipt. Missing accepted messages are reconciled before replaying their original immutable ID/body. Receipt records do not discard a later transport result. Retry invalidates the prior operation notice and sends its own outcome, including when the prior notice was already acknowledged. Restart recovers terminal results whose callback had not yet been created.

## Acceptance evidence

The real Pi/GitHub path published and enrolled [public fixture PR #5](https://github.com/lanej/octo-manager-acceptance-20261110/pull/5) and [private fixture PR #1](https://github.com/lanej/octo-manager-acceptance-private-20261112/pull/1). The private fixture required the phrase “acceptance behavior”; its pinned policy and published body satisfied that requirement. These are synthetic documentation changes; they establish publication and enrollment, not arbitrary semantic correctness. Controlled service tests additionally cover uncertain-create reconciliation, callbacks across restart, missing-message replay, receipt/send races, policy invalidation and cancellation.
