# Building a bounded worker with Pi

Pi's coding-agent SDK supplies a model conversation, tool execution, session history, and an event stream. An agent harness supplies the surrounding application: what work is allowed, how it is scheduled, where effects happen, and how completion is verified. Octo Manager uses Pi 1.5.0 as the reasoning loop inside a worker process; its coordinator and API remain ordinary application code.

## SDK pieces

| Pi component | Responsibility | Octo Manager choice |
|---|---|---|
| `ModelRuntime` | Models, providers, credentials | OpenAI Codex provider with existing authentication |
| `createAgentSession` / `AgentSession` | Prompt, model/tool loop, events, abort, disposal | One session per attempt |
| `ToolDefinition` | Typed parameters and an execution callback | Only tools for the submitted task |
| `DefaultResourceLoader` | Context files, skills, extensions, prompts, themes | Discovery disabled; fixed worker instructions |
| `SessionManager` | Conversation history | In memory; durable job history belongs to SQLite |
| `SettingsManager` | Session behavior and settings | In memory; SDK retries and compaction disabled |

The installed package's `docs/sdk.md` and `examples/sdk/12-full-control.ts` describe these boundaries. The version in `bun.lock` is the authority for the API used here; default factory behavior can discover resources and tools, so embedding hosts should select those explicitly.

## The working path

Read [worker.ts](../src/worker.ts) alongside [coordinator.ts](../src/coordinator.ts). The coordinator forks a worker, persists its PID, then grants permission to start. The worker creates its restricted session, subscribes to turn/tool/text events, and calls `session.prompt`. Tool callbacks send typed requests back to the coordinator; they do not execute Git or GitHub operations themselves. The coordinator validates each request and returns a result as tool content.

A PR-summary session has `read_pull_request`, bound to the exact public URL in its job. A conflict session has `read_conflict`, `write_resolution`, and `validate_resolution`, bound to a generated repository. The model cannot select another repository, launch a shell, or load project extensions through these tools. This restricts the application interface; Pi and its dependencies are still trusted host code.

The worker counts model turns and tool calls, batches text progress, and aborts on budget exhaustion or parent disconnect. The coordinator owns the three-minute deadline, cancellation, retries, and worker exit fence. After Pi finishes, the coordinator independently checks the result. A model saying the conflict is solved is insufficient: the required combined policy and clean two-parent merge must pass validation.

## Codex integration

Codex remains the interactive implementer and submits bounded work through `bin/octo-manager`. The [project skill](../.agents/skills/octo-manager/SKILL.md) provides the contract without installing an MCP server. Keep the request ID and job ID, observe state with `get`, and follow durable events with `events`. An uncertain submission is retried with the same request ID; a successful submission is only an acknowledgment.

The CLI and Charmed dashboard use generated clients for the [Connect API](api.md). This allows another Codex integration to speak the same contract without embedding Pi or importing SQLite. Dashboard disconnect cancels only its observation stream; job cancellation is an explicit API operation.

Authentication is a separate concern from job orchestration. [auth.ts](../src/auth.ts) prefers existing Pi authentication, then references a supported file-backed Codex ChatGPT access token in memory. It neither copies credentials into Pi storage nor owns Codex refresh. The README describes the supported session types and optional login path.

## Extending the worker

Add a task variant to the Protobuf contract and domain validation, then implement a coordinator-owned effect with explicit inputs and an independently checkable outcome. Expose only the corresponding typed Pi tools. Update generation and the end-to-end path before expanding scheduler policy. A future remote write needs an explicit authorization and reconciliation contract; the current implementation performs public GitHub reads only.

Keep provider retries separate from durable scheduler retries. Keep model text separate from confirmed state. Keep process shutdown separate from successful job completion. These distinctions let the same worker participate in a terminal session, a Codex workflow, or another API client without moving policy into the frontend.
