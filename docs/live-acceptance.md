# Live steel-thread acceptance

On 2026-11-08, Octo Manager ran the two-job `demo` under Bun 1.4.4 with the native Go/Charmed dashboard attached through the generated Connect client over a Unix socket. The Pi workers used the existing file-backed Codex ChatGPT session and existing GitHub CLI authentication. No additional sign-in or credential file was created.

![Charmed dashboard after both jobs succeeded](images/dashboard.png)

The screenshot shows actual persisted results from a 132-column, 40-row PTY. The captured ANSI output was replayed in xterm.js and photographed by headless Chromium; no sample snapshot was substituted. The PTY was continuously drained to avoid terminal backpressure. The final capture enables terminal colors rather than inheriting the automation environment's `NO_COLOR` setting.

The conflict job `3fda0d35-3196-487c-8b43-34549c18f2ae` passed through `queued`, `running`, `conflicted`, `resolving`, and `succeeded`. Its events contain real Git conflict markers and the live model's `read_conflict`, `write_resolution`, and `validate_resolution` calls. The coordinator independently checked the combined policy, clean worktree, and two-parent merge before reporting success.

```json
{"policy":{"maxAttempts":3,"timeoutSeconds":60,"retryDelaySeconds":1},"mergeCommit":"244a5420b432593b271bc9d3f4e6ff2155e21dd6","clean":true}
```

While that job was resolving, `q` exited the dashboard successfully. The coordinator remained alive, the job remained resolving, and both jobs completed without the dashboard attached. A new dashboard then attached and displayed their persisted results. The `bin/octo-manager dashboard` wrapper also attached and exited successfully. Resizing the native Go PTY to 80 columns and 32 rows produced the stacked layout below.

![PR summary in the resized Charmed dashboard](images/dashboard-narrow.png)

The conflict worker's exit was observed before job `600ebba4-1d23-47ac-a339-134eafd6263f` started. That second job read public [Pi PR 11546](https://github.com/earendil-works/pi/pull/11546) through the coordinator and returned a formatted summary. Both jobs succeeded on their first attempt, and both worker exits were recorded. Remote GitHub writes were not exercised; the worker supports public reads only.

`bun run check` builds both applications and passes the Bun scheduler/API tests plus the strict Go profile, race tests, and reachable-vulnerability scan. The generated Go client also runs unary and server-streaming calls against an actual Bun Unix-socket server in controlled tests. Independent review's stream-resynchronization and retry-output findings have regression coverage, including a real rejected Connect stream.

To repeat, follow the README build instructions, run `bin/octo-manager serve --state DIR`, attach `bin/octo-manager dashboard --state DIR` separately, and submit `bin/octo-manager demo --state DIR --request-id YOUR_UNIQUE_ID --json` from another terminal. Inspect both job handles with `get` and `events`. Existing usable credentials and network access are required; this records an observed run, not future provider availability. The recorded merge hash belongs to the disposable local acceptance repository and is not a published commit.
