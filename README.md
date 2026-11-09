# Octo Manager

A GitHub pull request dashboard backed by bounded Pi workers. Codex submits and observes jobs through a local CLI; Pi reasons with scoped tools; the coordinator owns Git/GitHub effects. The first working path covers public PR summaries and an actual disposable merge conflict.

![PR-centric Charmed dashboard with a visible GitHub URL and two runs](docs/images/dashboard.png)

See the [live acceptance record](docs/live-acceptance.md) for the actual conflict, PR summary, and detach/reattach evidence.

## Run

Requires Bun 1.4.4, Git, GitHub CLI, and the Go toolchain declared by `go.mod` (currently Go 1.26.10). Builds and checks select that Go toolchain automatically. Linux and macOS are supported.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bin/octo-manager serve
```

In another terminal, attach the native Charmed dashboard:

```sh
bin/octo-manager dashboard
```

From Codex or a third terminal:

```sh
bin/octo-manager submit summarize-pr --url https://github.com/earendil-works/pi/pull/11546 --request-id first-pr --json
bin/octo-manager get JOB_ID --json
bin/octo-manager events JOB_ID --watch
```

All processes use the same state directory. The default is `~/.local/state/octo-manager`; select another with `--state DIR` or `OCTO_MANAGER_STATE`. Existing prototype databases can be selected explicitly with `--state`; API clients must use the new Connect protocol. There is no installed daemon, automatic dotfiles setup, or MCP configuration change.

Quitting the dashboard detaches it and leaves jobs running. Stop `serve` explicitly with Ctrl-C for graceful coordinator shutdown. The dashboard reconnects when the service returns. Use `--theme dark`, `light`, `contrast`, or `mono` when launching the dashboard.

## Existing authentication

The worker uses existing Pi ChatGPT authentication when configured, otherwise a read-only in-memory reference to a fresh file-backed Codex ChatGPT session under `CODEX_HOME` (default `~/.codex`). It does not create a Pi credential file or pass through Codex refresh/identity tokens. Codex owns its session refresh. File-backed ChatGPT authentication is supported; keychain-only and API-key Codex sessions are not supported by this fallback.

If no usable session exists, `bin/octo-manager login` opens Pi with tools and discovery disabled. Enter `/login openai-codex`, complete sign-in, and `/quit`. GitHub reads use the existing `gh` login. Private or indeterminate repository visibility is rejected before content reaches the model. Public PR content goes to the selected model provider. The default model is `gpt-6.1-terra`; pass `--model MODEL` to `serve` to select another OpenAI Codex provider model.

## Dashboard and commands

The dashboard centers on pull requests: each canonical GitHub PR URL has one entry, with its worker runs underneath it. The selected PR shows `owner/repo#number` and its full URL. Press `o` to open it with the system browser (`open` on macOS, `xdg-open` on Linux), or use the visible URL directly. The conflict fixture is labeled as a local demo and has no browser target. Run success describes worker completion, not the PR’s merge/review state.

The dashboard uses Charmed themes, panels, focus, viewports, structured logs, and Glamour Markdown. Results and activity scroll independently. Use `j/k` or up/down to select a PR or demo, `h/l` or left/right to inspect its runs, Enter to expand, Tab to change pane, `[` and `]` to scroll, `p` to pause dispatch, `c` to cancel the selected run, `r` to retry it, and `q` to detach. Narrow terminals stack panes, and very small terminals retain a quit hint.

```text
octo-manager submit summarize-pr --url https://github.com/OWNER/REPO/pull/NUMBER --request-id ID
octo-manager get JOB_ID --json
octo-manager events JOB_ID --after SEQUENCE [--watch]
octo-manager cancel JOB_ID
octo-manager retry JOB_ID
octo-manager pause
octo-manager resume
```

CLI responses are JSON; `--json` selects compact output. Event pages contain at most 200 records. Retain submission request IDs when reconciling uncertain outcomes. Cancellation acknowledgment can precede worker exit; inspect the job until terminal. The project-local Codex skill under `.agents/skills/octo-manager` explains submission and observation without a global installation.

## API and architecture

The [Pi harness guide](docs/pi-guide.md) explains the SDK, bounded worker, and Codex integration. The [Protobuf contract](proto/octomanager/v1/scheduler.proto) generates Go and TypeScript bindings. ConnectRPC runs over HTTP/1.1 on an owner-only Unix socket. The [API guide](docs/api.md) defines cursor/replay semantics, idempotency, errors, deadlines, and disconnect behavior. The [architecture guide](docs/architecture.md) includes ownership and state diagrams.

`demo` first creates a real merge conflict in `retry-policy.json`, then queues a summary of public Pi PR 11546. The required merge keeps `maxAttempts=3` from the target and `timeoutSeconds=60` from the source, with `retryDelaySeconds=1`. The coordinator rejects either unchanged side, extra keys/paths, invalid values, and conflict markers, then commits and checks a clean two-parent merge. Only generated repositories are changed, and user hooks/signing are disabled for these fixtures.

Jobs have a three-minute attempt deadline, twelve model turns, forty tool calls, and bounded displayed output. Transient errors get at most three attempts with one- and five-second delays. Scheduler retries, cancellation, and crash recovery remain independently tested. This thread has no concurrent worker pool, recurring schedules, or remote GitHub mutation operations.

## Development

```sh
bun run generate
bun run check
```

Generation uses pinned Buf, Protobuf-ES, protoc-gen-go, and protoc-gen-connect-go versions. Checks build both applications, exercise the Bun scheduler and Connect API, and run the committed strict Go profile with race tests and reachable-vulnerability analysis. The same command runs in Linux/macOS CI. Provider-backed live acceptance requires network access and existing credentials; controlled tests do not establish provider availability.
