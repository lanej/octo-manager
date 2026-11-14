# Dashboard rendering performance

The dashboard uses Charmed’s retained runtime and keeps one compiled responsive layout for the current tab, expansion state, and header height. Resizing resolves that declaration again; changing tabs replaces it. Per-region revisions cover visible data, native scrolling, focus, errors, and the terminal palette. Charmed batches presentation at up to 60 frames per second and retains the completed frame between updates, without an idle presentation timer.

Pane sources are retained by value. Protobuf inputs are copied when they change, so mutating a snapshot in place without advancing its sequence still updates the display. Coordinator sequence and pointer identity are not visual cache keys. Output and review Markdown retain a prepared document across width changes; changed source or palette prepares a replacement. The existing 256 KiB source and 1 MiB rendered Markdown cache limits remain. Worker logs retain their native viewport, prepare only on worker tabs, and keep the latest 500 tool entries. GitHub traffic charts use `ApplyData` for equal observations and rebuild when their axis ranges or palette change.

The coordinator’s dashboard stream remains the only source of observations. Presentation revisions do not change GitHub polling, scheduler cadence, cancellation, or reconnect behavior. `runtime.Root` remains the Bubble Tea model; callers making synchronous snapshots after updates must use `PresentNow()` before reading its retained view.

## Matching microbenchmarks

The added `BenchmarkDashboard*` workloads compare Octo base `3795df1` with Charmed `c2cec551b6d1` against the retained implementation with Charmed `dad6311b0044`. Each snapshot workload clones and applies an equal observation, then renders the same tab at 132×40 with 30 tracked PRs, one Markdown worker result, and 100 tool events. Commands are not executed: these measure frontend update/render work, excluding transport, terminal output, and GitHub requests. Resize alternates 80×40 and 132×40, including both presentations per operation.

Measurements below are medians of three 100 ms samples on one Apple Silicon host with Go 1.26.11. They are diagnostic observations, not latency guarantees or process CPU measurements.

| Workload | Before (ms/op) | Retained (ms/op) |
| --- | ---: | ---: |
| Reviews, equal snapshot | 5.36 | 0.32 |
| Output, equal snapshot | 7.02 | 0.36 |
| Runtime, equal snapshot | 5.31 | 0.28 |
| Tracking, equal snapshot | 6.10 | 0.29 |
| Activity, equal snapshot | 1.42 | 0.21 |
| GitHub, equal snapshot | 4.02 | 0.24 |
| Two width changes and presentations | 22.43 | 12.91 |

Tracking allocated about 5.46 MB per equal snapshot before retention and 0.42 MB afterward. Idle `Root.View()` changed from rebuilding the scene (about 1.60 ms and 1.36 MB per call) to returning the completed frame with zero allocations. That idle access benchmark does not establish idle process CPU; reconnect ticks and incoming stream observations still have processing costs. Changed observations still generate changed pane content before presentation; the runtime coalesces completed frames, not application message processing.

Run the focused workloads with the repository’s declared Go toolchain:

```sh
go test ./internal/tui -run '^$' -bench BenchmarkDashboard -benchmem -benchtime=100ms -count=3
```

Use `gotestsum --jsonfile results.json -- ...` when collecting machine-readable output. Some gotestsum versions label benchmark cases as unknown failures despite the underlying package ending in a `pass` action; inspect the Go JSON result rather than discarding actual failures or interpreting that wrapper classification as a failed benchmark.
