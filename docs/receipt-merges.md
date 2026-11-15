# Receipt merges

A single owner readiness notice provides a linked PR and one command:

```markdown
[PR #38](https://github.com/lanej/octo-manager/pull/38) · Ready

`octo-manager merge 1b70e435`
```

`merge ID` records receipt and queues a one-shot request for that notice’s exact head. `ack ID` records receipt without authorizing a merge. `message ID --full` exposes the linked PR, pinned head and merge method for inspection. Both mutation commands use the registered session identity from the environment, with the same explicit overrides. Observers and messages with multiple owner Ready targets offer acknowledgment only. Other informational updates can share a message with one unambiguous merge target; the command acknowledges all frozen members and merges only that target. Other notification kinds do not grant a merge target.

## Readiness and scheduling

The merge scheduler owns eligibility reads. It reuses complete cached tracking evidence and fetches only the GitHub merge-gate metadata and branch rules for readiness, verifying their head and target against that evidence. The optional read has a 15-second deadline independent of service shutdown and shares the global request dispatcher, rate limits and spacing. At most one readiness inspection runs per scheduler tick; unchanged evidence and policy reuse a five-minute cache. No rendering or receipt command starts a GitHub read.

Ready requires complete check, workflow and review coverage, passing expected and required checks, a mergeable open PR, an allowed merge method, satisfied dependencies and GitHub review/protection gates. Drafts, required merge queues, unknown evidence, dependency preparation, paused chains and busy operations remain blockers. The automatic-merge switch controls automatic work; an explicit one-shot command preserves that switch. Readiness is an observed eligibility decision awaiting the owner’s choice, not a claim that the owner has assessed the changes.

The cache is invalidated by changed head, target, ownership, tracking epoch, checks, review evidence, dependency graph, merge policy or queue recipients. Each semantic readiness decision has a distinct immutable message and generation. It replaces queue-covered completion deliveries without recording a receipt; direct-turn recipients retain their normal check delivery. The latest same-head completion generation supersedes older queue copies. A completed check notice can report the remaining blocker. If approval arrives after that notice was acknowledged, a fresh Ready workflow notice provides its own immutable receipt ID. Duplicate unchanged observations do not repeat it. Superseded readiness notices are withdrawn through the normal queue reconciler.

Known unmerged dependencies are evaluated from cached state before optional eligibility reads. Inspection failures retain a diagnostic and retry deadline separately from the last confirmed eligibility decision. Failed reads suppress Ready offers and reject new receipt merge requests until a successful inspection; failure and recovery alone do not create new notification generations. Real eligibility changes still produce fresh notices.

## Execution and recovery

The command returns queued status promptly. The existing merge scheduler reads fresh evidence before execution, checks the pinned owner/context again at dispatch and supplies the exact head to GitHub without bypassing protection rules. GitHub’s accepted asynchronous operation is polled by its saved request ID; only a confirmed result is reported as merged.

A stale head, changed evidence or blocked gate does not authorize a replacement head or preparation work. A blocked one-shot stops rather than becoming persistent auto-merge. A later fresh Ready notice can authorize another explicit request. Repeating an old command returns its saved request’s status; it does not rebind that receipt or issue another write. Unknown remote outcomes retain the existing operation lease and require reconciliation before another operation.

Receipt remains distinct from merge acceptance and outcome. A declined request can still have a successful receipt. If a response is lost, retry the same public ID to inspect/reconcile that request. Optional Codex hooks recognize the command footer for exact-body acknowledgment only; displaying or receiving a merge command never executes it.

## Durable records

Immutable digest revisions retain an optional typed `mergeTarget` alongside their dispatch ID and members. `settings` keys `merge-readiness:PR_ID` retain the validated readiness target, evidence fingerprint, policy fingerprint, result, semantic generation, queue recipients, diagnostic and integer millisecond deadlines. `receipt-merge:DISPATCH_ID` binds a dispatch to its merge entry permanently. Merge entries carry optional receipt/context pins; existing chain, operation and notice records provide execution and recovery history. These additive JSON records require no table rewrite. Current code reads existing records without these optional fields; older binaries cannot interpret newly extended records.

Generated PR references use Markdown links. Reference discovery excludes fenced and inline code examples and does not resolve a Markdown link’s label against the source repository when its URL names another repository. Original source evidence remains available through the linked PR or comment.
