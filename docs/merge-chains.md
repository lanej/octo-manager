# Dependency-aware merge chains

Octo can watch a dependency across repositories, prepare its dependent PR with a configured tool recipe, and merge explicitly queued PRs after their owners assess the current heads. Tracking a PR, discovering a reference, and confirming a dependency never authorize merging. A prerequisite outside the selected targets is watched only.

## Contracts and ownership

| Record | Meaning | Owner and invalidation |
| --- | --- | --- |
| Reference | Description/comment source, revision, excerpt, evidence URL, target, relationship hint | Suggested until the source PR owner confirms, marks related, or dismisses it; edits retire old suggestions |
| Dependency | Directed dependent → prerequisite edge, confirmer, reason, optional preparation profile | Dependent owner confirms/removes; self links and cycles are rejected; source edits never remove confirmed edges |
| Chain and entries | Explicit merge targets, method, expected checks or no-CI declaration | A registered calling agent queues exactly these tracked PRs; pause/cancel stops future writes |
| Owner assessment | Exact head, target branch, owner, enrollment epoch, actionable feedback fingerprint, graph fingerprint, time | Current PR owner; new head, ownership, enrollment, target, actionable feedback, or graph/check-policy change invalidates it |
| Operation | Original head/base, graph/owner/enrollment, recipe inputs, phase, attempted/confirmed/failed/uncertain outcome | Coordinator records before effects; one in-flight operation per PR; uncertain operations hold the lease |
| Workflow notice | Immutable subject/revision/body and per-recipient receipt | Existing inbox and digest coordinator withdraws superseded notices before replacement; receipt does not authorize a merge |

Schema 13 adds `pr_references`, `pr_dependencies`, `merge_chains`, `merge_entries`, `merge_operations`, `merge_conflict_cases`, and `merge_notices`, plus cached description text on observations. State columns use checked string enums; payloads are validated JSON. Existing identifiers survive migration; timestamps remain integer Unix milliseconds. Operation identity and preparation inputs are immutable after recording.

Descriptions and comments already fetched by tracking supply references without extra discovery requests. Full PR URLs are recognized directly; shorthand links remain ambiguous issue-or-PR references until tracked/confirmed. Unknown targets are saved but neither fetched recursively nor enrolled. Use `track` normally before confirming an unknown prerequisite. Reference hints never decide dependency direction.

## Queue and assess

Create an intent file, then submit it through the coordinator:

```json
{"requestId":"release-chain-1","actorId":"REGISTERED_AGENT_ID","entries":[{"prUrl":"https://github.com/owner/library/pull/1","checks":["CI"]},{"prUrl":"https://github.com/owner/application/pull/2","checks":["CI"]}]}
```

```sh
octo-manager queue-chain --intent-file chain.json
octo-manager references https://github.com/owner/application/pull/2
octo-manager merge-command --intent-file dependency.json
octo-manager merge-ready https://github.com/owner/library/pull/1 --head FULL_SHA --agent-id OWNER_ID
octo-manager chains CHAIN_ID
```

`dependency.json` specifies the dependent first; use the source PR's current owner:

```json
{"op":"confirm","pr":"https://github.com/owner/application/pull/2","prerequisite":"https://github.com/owner/library/pull/1","actorId":"DEPENDENT_OWNER_ID","reason":"Application requires the merged library","profile":"library-pin"}
```

Omit `profile` for a merge-only dependency. Supply `referenceId` when confirming a discovered reference. Other `merge-command` intents are `decide` (`id`, `actorId`, `decision` of `related` or `dismissed`), `policy` (`pr`, `actorId`, `checks`, `noCi`), and `remove` (`id`, `actorId`). `dependency-remove ID --agent-id OWNER_ID` is equivalent to `remove`.

Assess readiness after evaluating review feedback, optionally while CI is running. Expected check names are exact; they combine with GitHub's required check contexts. Missing, incomplete, pending, or failing relevant evidence waits. An unprotected repository requires an explicit expected set or `noCi:true`; advisory checks outside the selected/required set do not block. The default merge method is squash; queue entries may explicitly select merge or rebase if the repository permits it. Drafts and GitHub eligibility gates still block. Repositories requiring GitHub merge queues remain blocked; this version does not enqueue into that queue or request administrative bypass.

Readiness is rechecked after provider reads and when the shared GitHub queue dispatches the merge. The REST merge request includes the expected head `sha`. Authorization persists across later heads, but owner assessment does not: the owner must assess each resulting head. GitHub remains authoritative for branch protection and concurrent remote changes. Octo cannot make a remote comment and a merge atomic.

## Deterministic preparation

Profiles live in the operator's `config.json` under `merging`, separate from untrusted PR evidence. Commands are explicit argv arrays and run in an isolated checkout of the declared repository. A profile cannot choose a model or launch an agent.

```json
{"merging":{"library-pin":{"kind":"toml_revision","repository":"owner/application","path":"versions.toml","key":["tools","library","revision"],"expectedValue":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checks":[["bun","run","check"]],"timeoutMs":120000}}}
```

The prerequisite must be merged with a confirmed merge commit, rather than merely closed. Preparation rebases onto the current target, tries the existing conservative YAML conflict recipe, then replaces one exact TOML revision with that actual merge commit. The TOML key must be a simple bare table/key path and the current value must equal the configured expected revision or already equal the desired revision; formatting and comments are preserved. Ambiguous text, unsupported conflicts, forks, merge commits, changed values, or failed validation return an owner handoff. `kind:"rebase"` uses the same repository/check/timeout fields without a pin.

Validation must leave a clean worktree. The push uses the original source SHA as an exact force-with-lease and checks that the target did not move. Prepared results require renewed owner assessment. Multiple preparation-bearing edges currently require an owner-composed recipe; ordinary multiple merge-only prerequisites work together. Definite preparation/merge failures require another owner assessment; they are not retried as repairs automatically. Unresolved conflict inputs and recipe decisions are retained in the operation conflict cases. Preparation workspaces are retained for inspection under the state directory.

## Stop and recover

```sh
octo-manager pause-chain CHAIN_ID
octo-manager resume-chain CHAIN_ID
octo-manager cancel-chain CHAIN_ID
octo-manager reconcile-operation OPERATION_ID
octo-manager chains CHAIN_ID --full
```

An external operation already in flight can finish after pause/cancel. Interrupted local-only work is failed; an interrupted push/merge is uncertain. Reconciliation inspects the remote result and never resends the operation. A confirmed matching prepared head or actual merge resolves the lease; inconclusive evidence keeps it uncertain. Policy and graph edits are blocked while a dependent PR has an in-flight/uncertain operation. A merged result observed after an uncertain merge confirms the PR state without claiming which actor merged it.

Provider requests share tracking's serialized GitHub budgets, rate-limit headers, and cooldown. Evaluation retries are paced to at least one minute. Waiting for owner assessment or an open prerequisite uses cached tracking evidence; discovered links do not cause a crawl.

## Presentation and verification

Tracking shows the merge state, next step, and prerequisite PR links. Workflow notices reuse canonical inbox/digest receipts and withdrawal. Agent CLI responses use the shared eight-row/3000-byte budget; `--full` is available only on explicit inspection commands. Mutation recovery commands inspect state instead of repeating effects.

Controlled acceptance exercises the real Unix-socket API through an upstream merge, downstream preparation, renewed owner assessment, and dependent merge. A disposable local bare Git remote verifies actual rebase, TOML repin, clean validation, and leased push. Provider fixtures test policy revocation, dispatch cancellation, definite/unknown failures, restart leases, and notice withdrawal/resume. These checks do not establish live GitHub merge compatibility; run a separate opt-in disposable two-repository provider trial before enabling unattended production chains. This change does not arm existing tracked PRs.

The opt-in live runner creates two **new private repositories**, queues only their fixture PRs in an isolated state directory, merges them, and verifies the resulting application pin. It retains the remote repositories for inspection and reports their names; it removes local temporary state after success and retains it on failure. It does not use the installed coordinator or any existing tracked PR. Run it only when ready to create and merge these fixtures:

```sh
OCTO_LIVE_MERGE_ACCEPTANCE=1 OCTO_ACCEPTANCE_OWNER=YOUR_LOGIN bun scripts/test-merge-acceptance.ts
```

Provider contracts: [head-pinned REST merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [effective branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch), and [GitHub merge-state values](https://docs.github.com/en/graphql/reference/pulls#mergestatestatus).
