# Live steel-thread acceptance

On 2026-11-08, the native Pi dashboard ran the two-job `demo` using the existing file-backed Codex ChatGPT session and existing GitHub CLI authentication. No additional sign-in or credential file was created.

The conflict job `ed133c0d-0723-46bd-930c-5db9e701cb94` passed through `queued`, `running`, `conflicted`, `resolving`, and `succeeded`. Its event stream contained actual Git conflict markers, then the live model called `read_conflict`, `write_resolution`, and `validate_resolution`. The coordinator independently checked the required policy, clean worktree, and two-parent merge before reporting success.

```json
{"policy":{"maxAttempts":3,"timeoutSeconds":60,"retryDelaySeconds":1},"mergeCommit":"02d75f1577775c73ed3a1693195aa5d5d505d68c","clean":true}
```

The conflict worker's exit was observed before job `75334b5d-d9bc-4b0c-a0fc-c5e844bc21f5` started. That second job read public [Pi PR 11546](https://github.com/earendil-works/pi/pull/11546) through the coordinator and successfully returned a summary of its output-buffer cap and related changes. Both jobs succeeded on their first attempt, and their worker exits were recorded. Remote GitHub writes were not exercised; this worker supports reads only.

`npm run check` passed all 24 tests, including synthetic auth-reference tests and scheduler/process regressions. Independent static review found no actionable blockers in the authentication changes. The disposable repository and temporary scheduler state were removed after inspection; the recorded merge hash identifies that local acceptance run and is not a published commit.

To repeat, build the project, start `bin/pi-github dashboard`, and run `bin/pi-github demo --request-id YOUR_UNIQUE_ID --json` from another terminal using the same state directory. Inspect both job handles with `get` and `events`. A usable existing session and network access are required; this result establishes the observed run, not future provider availability.
