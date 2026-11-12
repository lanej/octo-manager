# Local installation and Codex integration

Octo takes over GitHub check and review monitoring after a PR is enrolled. Agents can finish their local work and move on; failed checks and new or edited review summaries, inline comments, and conversation comments return through the durable inbox. A notification requests triage and reporting; it does not grant repair or merge authority.

## Install on macOS

Use the pinned Bun 1.4.4, the repository dependencies, GitHub CLI with an existing login, and the Go toolchain from `go.mod`. Commit reviewed source changes before installing:

```sh
bun scripts/install-local.ts --codex
~/.local/bin/octo-manager dashboard
```

The installer builds a revision-specific release under `~/.local/share/octo-manager/releases/`, installs production dependencies with lifecycle scripts disabled, and points the stable launcher at `current`. The service uses absolute release paths and a private pinned Bun, so it does not depend on a source checkout, shell startup files, or the caller's working directory. Existing state stays in `~/.local/state/octo-manager` unless `OCTO_MANAGER_STATE` overrides it. Do not run a manual coordinator against the same state while starting the service. `--no-start` stages the release and configuration without starting it, for a controlled handover from an existing manual process.

The user LaunchAgent `com.lanej.octo-manager` starts at login and restarts the coordinator if it exits. Its definition is `~/Library/LaunchAgents/com.lanej.octo-manager.plist`; logs are in the state directory's `coordinator.log`. The installer preserves prior launcher and changed configuration under `install-backups/<revision>/` in that state directory. Installation is not a transaction across all these files; inspect errors and backups before retrying a failed installation.

```sh
launchctl print gui/$(id -u)/com.lanej.octo-manager
launchctl kickstart -k gui/$(id -u)/com.lanej.octo-manager
```

Linux continues to use the manual coordinator described in the README. `--home DIR` supports a separate installation root; normal configuration overrides `XDG_CONFIG_HOME` and `CODEX_HOME` remain supported.

## Activate native Codex hooks

`--codex` appends three command-hook groups to `CODEX_HOME/hooks.json` without reordering or replacing existing hooks. It defaults an absent local endpoint delivery mode to `queue`, preserving an explicitly selected delivery mode. It changes neither MCP configuration nor Codex trust settings.

Codex requires review and trust of new hook definitions through its supported `/hooks` flow before they execute. Review the three Octo commands pointing at the installed launcher; see the [Codex hook documentation](https://learn.chatgpt.com/docs/hooks). Installation alone does not establish hook activation. Existing running sessions may need to reload their hooks or resume after approval.

| Event | Behavior |
| --- | --- |
| SessionStart | Register the current session and recover applicable unread notifications. |
| UserPromptSubmit | Record receipt of an exact incoming Octo message and recover applicable unread notifications. |
| PostToolUse | After successful native `attach_artifact` of a GitHub pull request, queue enrollment under the calling session. |

PR attachment is the initial automatic enrollment path for the Codex desktop app. A plain CLI session or a PR that is never attached still needs explicit `octo-manager track --url URL --thread-id THREAD_ID`. Arbitrary shell output and GitHub URLs in prose do not trigger enrollment. Subagent hooks use Codex's parent session ID, preserving parent ownership.

## Delivery and recovery

PR attachment writes a bounded, private file intake before contacting GitHub. The coordinator drains it asynchronously; downtime preserves the handoff. Repeated attachments coalesce. An existing different owner is retained and the requesting session sees an enrollment warning. Later accepted enrollment clears that warning while retaining its archived evidence.

The existing coordinator owns GitHub polling, check watches, durable notifications, and native app-server queue delivery. Hooks only enroll sessions, queue PR intake, and acknowledge receipt. Recovery filters applicability before pagination, returns at most three notifications within a bounded context, and records their receipts only after writing the hook output successfully. A receipt means the host accepted notification context, not that the model processed it or accepted or resolved the associated action. If output or receipt fails, the notification can be replayed. Large notifications remain unread and include a retrieval hint rather than being silently truncated and acknowledged.

Session setup supplies standing evidence-handling rules once. Recovery retains the original action and immutable evidence identifiers without repeating those rules in every message. Full-body matching prevents a delivery marker copied into an altered prompt from acknowledging the original notification. Hooks are advisory and do not block ordinary agent work if the coordinator is unavailable.

Useful recovery commands are in the [tracking guide](tracking.md). Existing inbox and action records remain compatible; the API adds optional registration, full-body receipt validation, and applicable-only listing without a database migration.
