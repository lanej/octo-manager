# Repository automation policy

`octo-manager.toml` configures notification instructions and the default auto-merge switch for a local repository. Enrollment through `pr track`, publication with tracking, or the PR attachment hook binds the verified Git checkout to the matching GitHub repository. Use `--cwd` with the actual checkout for explicit enrollment. Octo does not fetch configuration from GitHub PR content.

```toml
schema_version = 1

[merging]
auto_merge = "project_stage"

[notifications.instructions]
review_feedback = "Inspect and address actionable review findings."
checks_failed = "Inspect the failed run and address the cause."
merge_conflict = "Inspect and resolve the merge conflict."
dependencies_pending = "Inspect and report remaining prerequisites."
owner_review_required = "Review the current head and record readiness when satisfied."
merged = "Report completion and perform configured post-merge follow-up."
merge_uncertain = "Inspect reconciliation evidence before retrying."
```

`project_stage` reads the installed stage from `.source-code.json`: research and alpha enable the repository default; beta, production, and missing or unknown stages disable it. Literal `true` or `false` selects a fixed default. Existing explicit choices are preserved. `pr auto-merge PR --on` or `--off` records an explicit switch; `--inherit` resumes repository policy. Supply the registered `--agent-id` or its environment value. A switch change invalidates owner readiness. Checks, dependencies, owner assessment, and GitHub confirmation remain distinct gates. Already-submitted operations continue reconciliation even when inherited auto-merge turns off.

Directory watches invalidate retained policy files when configuration changes, including atomic replacement. A parent-directory watch detects replacement of the bound repository root. A five-minute scheduler safety pass revalidates files and watches; unavailable file intake retries every five seconds. These local reads do not make GitHub requests. Policy files must be regular files of at most 64 KiB; each instruction is limited to 1,000 UTF-8 bytes. A malformed, missing, or unavailable bound policy suspends inherited automatic merging and retains last-valid instruction text. The diagnostic is recorded only when it changes. Explicit switches remain independent. Re-enrollment binds a replacement checkout if a temporary worktree is removed.

Built-in state instructions provide the baseline. Repository keys override individual states; `ready` and `merge_blocked` are also supported. An empty value disables that state’s default instruction. Caller `--instructions` adds task-specific context. Instructions are delivered only to the current owner; they do not transfer across ownership or tracking epochs. Grouped messages include shared text once per PR. Selection uses typed state and current evidence; failed checks and uncertain writes are not described as Ready. Frozen messages retain the exact instructions sent with them. Receipt does not complete the requested follow-up or grant new authority.

`pr show PR --full` exposes the bound root, effective stage, policy hash, instruction overrides, and load diagnostic. Merge-chain inspection and the dashboard show whether the auto-merge switch is inherited or explicit. State policies do not create recurring passive-wait notifications.

Source-code seeds this TOML when the project selects its Octo integration. Existing authored files, including a concurrent creator’s file, are preserved. Shadow setup excludes a newly seeded file locally; it does not hide an already tracked repository policy. Setup and upgrades do not rewrite the authored TOML as stages change.
