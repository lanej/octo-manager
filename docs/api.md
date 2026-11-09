# Scheduler API v1

The source of truth is [`scheduler.proto`](../proto/octomanager/v1/scheduler.proto), in the `octomanager.v1` package. `bun run generate` runs Buf lint and pinned Go and TypeScript generators. Commit the schema and both generated outputs together. CI regenerates them and rejects drift. Never reuse field numbers or enum values; incompatible behavior needs a new API version.

## Transport and ownership

The Bun coordinator serves the official Connect Node adapter through Bun's Node HTTP implementation, using HTTP/1.1 on `STATE/run.sock`. Go uses the generated Connect client with a custom `net/http` Unix dialer. The TypeScript CLI uses the official Connect Node client with `socketPath`; requests use independent HTTP connections so stream cancellation or restart cannot reuse a stale Bun connection. Both binary Protobuf and Connect JSON use the same contract. No TCP listener is opened.

The state directory is owner-only (0700), and the socket is owner-only (0600). The coordinator acquires its SQLite ownership lock before removing a stale socket. These permissions isolate other accounts; unrestricted processes under the same account remain trusted. The frontend never reads SQLite or provider credentials and cannot execute Git commands. Workers retain their existing scoped tool protocol inside the coordinator.

## Operations

| RPC | Confirmation |
| --- | --- |
| `SubmitJob` | Returns the durable job handle; acceptance is not completion. |
| `GetJob` | Returns the current confirmed job state and optional result/error. |
| `GetSnapshot` | Returns scheduler/worker state, jobs, the latest 100 events, an instance ID, and a sequence cursor. |
| `ListEvents` | Returns up to 200 events strictly after a sequence, optionally filtered by job. |
| `Watch` | Streams persisted events strictly after the requested sequence, optionally filtered by job. |
| `CancelJob` | May return `cancelling`; inspect subsequent state until `cancelled`. |
| `RetryJob` | Explicitly requeues failed/interrupted work after the previous worker fence clears. |
| `SetPaused` | Confirms dispatch pause/resume; active work continues. |

`Task` is a Protobuf `oneof`: summarize a public GitHub pull request or run the disposable conflict fixture. State, attempt timestamps, worker exit observations, errors, and Markdown results are typed fields. Job state is a stable enum; event `kind` remains a string so additional observations can be displayed without inventing a parallel domain model. Clients must tolerate unknown event kinds and display unknown enum values safely.

## Snapshot, watch, and reconnect

1. Obtain `GetSnapshot`, including `instance_id` and `sequence`.
2. Start `Watch` with that instance ID and `after_sequence=sequence`.
3. Process events in increasing sequence order. Persist a cursor only after processing its event; deduplicate repeated sequences after reconnect.
4. Resume with the last processed cursor after a transport failure.

The single coordinator owns all writes, and snapshot reads do not yield. The snapshot and cursor therefore represent one consistent point in that owner's execution. Events created between the snapshot and the watch are replayed from SQLite. Event history is retained for the life of the database; there is currently no pruning policy.

The instance ID is persisted in that database and survives coordinator restart. Replacing the database creates a new instance. A mismatched instance produces `FailedPrecondition`; a cursor ahead of the available history produces `OutOfRange`. Both require a fresh snapshot rather than silently moving the cursor. Timestamps describe observations; sequence numbers determine order.

The Charmed frontend groups jobs by their canonical PR task URL; jobs and attempts remain execution handles below that identity. Case differences and a trailing slash do not create separate PR entries. Browser opening is local to the frontend and does not mutate scheduler state or GitHub.

The Charmed frontend uses watch events to request fresh snapshots and also refreshes once per second for reconnection and liveness. It serializes snapshot requests, keeps results visible during connection loss, and displays unconfirmed command failures. Its activity pane shows recent transitions and tool calls; `ListEvents` exposes the complete paginated record, including streamed text fragments.

Closing a watch or quitting the TUI cancels client I/O only. It does not cancel a job, stop the coordinator, or refresh provider credentials. Stop `serve` explicitly to shut down the coordinator; its existing interruption and worker-exit rules apply.

## Idempotency and errors

Repeating a `SubmitJob` request ID with the same task returns the existing job. Reusing it with a different task returns `AlreadyExists`. After an uncertain submission, retry with the original ID instead of creating another job. Cancel/retry outcomes should be reconciled with `GetJob`; the transport does not blindly retry mutations.

| Connect code | Meaning |
| --- | --- |
| `InvalidArgument` | Missing/invalid task, URL, or request ID. |
| `NotFound` | Unknown job. |
| `AlreadyExists` | Request ID reused for a different task. |
| `FailedPrecondition` | Retry fence/state violation or replaced state instance. |
| `OutOfRange` | Cursor outside available history. |
| `Unavailable` | Coordinator is shutting down or cannot be reached. |
| `Internal` | Unexpected coordinator failure; internal details are withheld. |

The server limits decoded requests to 16 KiB and responses to 4 MiB. Unary application calls use ten-second deadlines; watch is a long-lived cancellable stream. The TypeScript client's default deadline can be overridden through Connect call options for a long-lived watch. Streaming framing, flow control, cancellation, and status encoding belong to the official Connect implementations.

## Verification

Automated checks run actual generated Go unary/streaming calls against the Bun server over a Unix socket, with a real disposable Git conflict and a controlled worker. They check snapshot/watch gaps, replay, typed failures, duplicate submissions, pagination, stream cancellation, and persisted identity on restart. Scheduler tests continue to exercise process fencing and recovery. Provider-backed acceptance is recorded separately and is not established by the controlled worker.
