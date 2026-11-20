# Command-line interface

`octo-manager --help` lists capability groups. Each command owns its arguments and options; `octo-manager pr publish --help` and `octo-manager messages ack --help` work without a running coordinator. `--version` displays the application version. Invalid commands, options, missing arguments, and conflicting switches fail before execution.

| Group | Purpose |
| --- | --- |
| `pr` | Initialize and inspect publication guidance, validate and publish caller-written drafts, track PRs, manage subscriptions, and configure merge policy |
| `issue` | Enroll issues, inspect lifecycle evidence, approve brief/publication/follow-up work, answer clarification, and pause/resume/cancel |
| `agent` | Register sessions, inspect registered agents, and read inbox or tracking state |
| `messages` | Inspect frozen messages and revisions, acknowledge receipt, or request their pinned merge |
| `action` | Inspect blockers, accept work, change profiles, and retry delivery |
| `chain` | Queue, inspect, pause, resume, cancel, and reconcile merge operations |
| `dependency`, `reference` | Inspect and explicitly confirm dependencies or dismiss references |
| `job`, `repair`, `conflict` | Manage background jobs, explicitly request rebases, and inspect retained repair evidence |
| `activity` | Read the activity log or record a caller-observed operation |
| `publication` | Inspect and reconcile the standalone publisher's durable receipts |
| `history` | Read archived submissions and repository policies |

`ack ID`, `merge ID`, and `message ID` remain short commands for agent notifications. Receipt and merge authority remain separate: receiving a command never executes it. Stored digest receipt commands and installed hook entrypoints have narrow compatibility forms; new commands and documentation use capability groups.

Use `--state DIRECTORY` for another coordinator and `--cwd DIRECTORY` for caller context. Identity comes from explicit options or the existing Octo/Codex environment. Receipt identity must identify a registered session; receipt does not register one. `--json` requests structured output. Agent detection selects bounded JSON automatically, and `--full` is reserved for read-only inspection. Agent event streaming requires explicit full inspection. Output recovery commands use the same grouped CLI.

```sh
octo-manager pr track --url https://github.com/owner/repo/pull/42 --thread-id SESSION
octo-manager pr list
octo-manager pr show PR_ID --full
octo-manager pr auto-merge PR_ID --on --agent-id AGENT_ID --instructions 'After merge, pull latest and reinstall.'
octo-manager pr policy PR_ID --checks 'Linux checks,macOS checks' --agent-id AGENT_ID
octo-manager activity list
octo-manager history policy owner/repo --policy-version 2 --tier routine
```

`pr publish --title TITLE --body-file FILE` uses the caller-written description and local publication contract. It remains a standalone publisher with a separate receipt journal; it does not acquire the daemon lock. The daemon automatically reconciles uncertain legacy publications through scheduled GitHub reads without drafting or creating PRs.

Issue commands and maturity-dependent configuration are in [issue setup](issues.md); [issue flows](issue-flows.md) distinguish approval, dispatch acceptance, verification, and closure.
