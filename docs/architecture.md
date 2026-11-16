# Architecture

Octo Manager coordinates issue remediation and PR delivery. The Bun coordinator owns durable lifecycle state, scheduling, policy decisions, and daemon-backed effects. A Charmed Go dashboard and CLI use the generated [Connect API](api.md). The standalone PR publisher has a separate receipt journal and does not acquire the coordinator's database lock.

## Capability boundaries

```mermaid
flowchart LR
    CLI[CLI and calling agents] -->|Connect over Unix socket| App[Bun application services]
    TUI[Charmed Go dashboard] -->|Generated Connect client| App
    App --> Store[(SQLite state, intentions, evidence)]
    App --> TrackerPort[Issue-tracker port]
    App --> DispatchPort[Agent-dispatcher port]
    App --> CodePort[Code-host port and existing PR services]
    TrackerPort --> Tracker[GitHub issues adapter]
    DispatchPort --> Codex[Codex app-server adapter]
    CodePort --> Git[Guarded Git and GitHub publication]
    App --> Pi[Bounded Pi job and repair workers]
```

Pragmatic hexagonal architecture keeps lifecycle decisions in a functional core with explicit state and observations. Application services coordinate persistence and effects. Issue-tracker, dispatcher, workspace, and code-host ports isolate demonstrated replacement boundaries; they do not form a universal plugin framework. The first issue tracker is GitHub and the first issue dispatcher is Codex. A different issue tracker can still deliver fixes through GitHub PRs. Provider payloads and protocol details stay in adapters. See [issue flows](issue-flows.md) for the review-level state machines and authority boundaries.

| Capability | Owns | Important separation |
| --- | --- | --- |
| Issues | Brief versions, questions, approvals, lifecycle and acceptance | Done is distinct from tracker closure. |
| Dispatch | Scoped stage assignments, session/turn identity, recovery and cancellation | Accepted interruption is distinct from terminal execution. |
| PR tracking | Provider observations, ownership, blockers, receipts and notifications | Receipt is distinct from action acceptance and observed resolution. |
| Merging/repairs | Explicit dependencies, exact-head readiness, guarded Git work and confirmation | A configured auto-merge switch is distinct from eligibility or a confirmed merge. |
| Publication | Caller-written description, local format contract, frozen request and receipt | Accepted publication is distinct from GitHub creation and tracking enrollment. |
| Pi jobs | Existing bounded summary/conflict tools and worker process lifecycle | Job/PID recovery is distinct from Codex issue-session recovery. |

The coordinator can post issue questions/plans, create approved follow-ups, publish PRs, repair branches, merge authorized PRs, and close verified issues. Those capabilities have separate authorization and evidence gates; observing an issue or receiving a notification grants none of them implicitly. GitHub tracking accepts public and private repositories using existing access; the older Pi summary demo retains its public-only restriction.

## Issue orchestration

The issue application owns stages and orthogonal waiting conditions. Explicit enrollment starts investigation. A versioned brief plus repository/operator authority allows implementation. Testing and authorized publication connect to existing PR tracking. A confirmed merge starts separate acceptance verification; a fresh issue observation guards the subsequent close effect.

New input advances the issue epoch before assessment. New briefs clear implementation/publication approvals; no-change assessments retain them. Async results are checked against current epoch, brief, assignment, approvals and policy before application. Already-submitted effects may still complete after a pause/cancel, but their confirmation cannot revive superseded work. Unknown agent acceptance is reconciled through saved session/turn identity, not by starting a replacement. [Assignment recovery and effect flows](issue-flows.md#agent-assignment-and-recovery) detail these transitions and current limits.

The coordinator owns local commits and remote publication. Codex implementation receives workspace-write access without network access; investigation and verification are read-only. Guarded Git effects resolve trusted linked metadata, disable hooks/fsmonitor/signing/filter execution, and reject changed paths needing custom content filters. This is a constrained integration boundary, not a general OS container or a proof that model-generated code is correct.

## Scheduling and presentation

The shared scheduler dispatches provider reads with request spacing, adaptive polling, separate REST/GraphQL budgets, and cooldowns. Services retain observations and explicit completeness; failed or partial reads do not establish a clean state. [Polling](polling-and-auto-merge.md), [tracking](tracking.md), and [merge chains](merge-chains.md) describe their respective freshness and eligibility contracts.

Charmed supplies semantic themes, compiled responsive layouts, focus, viewports, logs, prepared Markdown and retained rendering. The Go frontend owns terminal lifecycle, navigation and cached presentation, not provider polling or domain transitions. Views receive stored frames on the coordinator tick; refresh requests schedule work while cached content remains visible. Disconnecting a dashboard does not cancel jobs or issue assignments. See [dashboard layout](dashboard.md) and the dated [performance evidence](dashboard-performance.md).

## Pi job state machine

The existing Pi job executor retains durable FIFO order, idempotent submissions, bounded retries, and worker PID/exit fencing. These are execution jobs, not the issue lifecycle or Codex assignment journal.

```mermaid
stateDiagram-v2
    [*] --> queued: submit
    queued --> Active: dispatch
    state Active {
        [*] --> running
        running --> conflicted: Git conflict
        conflicted --> resolving: start Pi
    }
    Active --> succeeded: verified result and worker exit
    Active --> failed: permanent failure or exhausted retries
    Active --> retry_wait: transient failure
    Active --> cancelling: cancel
    Active --> interrupted: shutdown or restart
    retry_wait --> queued: backoff elapsed
    queued --> cancelled: cancel
    retry_wait --> cancelled: cancel
    cancelling --> cancelled: worker exited
    cancelling --> interrupted: shutdown or restart
    failed --> queued: explicit retry
    interrupted --> queued: retry after PID fence clears
```

Worker job completion and slot cleanup are separate observations. Cancellation holds the Pi slot until worker exit; restart interrupts jobs and fences replacement against unresolved PIDs. Pi workers use scoped tools with project discovery and built-in shell tools disabled. That restriction applies to these workers; Codex issue sessions use their own scoped sandbox and dispatcher lifecycle. [Issue assignment recovery](issue-flows.md#agent-assignment-and-recovery) preserves the corresponding session/turn distinction.
