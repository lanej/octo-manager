# Dashboard

Run `octo-manager dashboard` to connect to a running coordinator. Attention opens first and places uncertain outcomes and operator decisions ahead of ordinary progress. The OpenTUI dashboard is a separate Bun process. Quitting or losing the terminal disconnects its client while the coordinator keeps working.

| View | Evidence and controls |
| --- | --- |
| **1 Attention** | Inspect PRs needing intervention, their observed condition, and the next step. |
| **2 Deliveries** | Browse the full PR inventory, including closed and merged PRs and their retained evidence. |
| **3 Activity** | Inspect saved operations and historical reports. Use `h/l` for older/newer pages, `u` for refresh or retry, and `r` to reconcile an eligible uncertain operation. |
| **d Diagnostics** | Open Reviews, Output, Runtime, Tracking, GitHub, and Issues on keys **1–6**. Esc returns to the originating view. |

Use `j/k` or the arrow keys to move, Enter to inspect, Esc to return, `[` and `]` to scroll evidence, and `q` to detach. Wide terminals preview the selected record beside the list. Enter opens full-width delivery detail from Attention or Deliveries. Narrow terminals show one pane at a time. Selection follows the record identity through live updates. If the selected record disappears, the dashboard exits its inspection. Very short terminals retain a quit hint.

Reviews shows cached review bodies and their observed revision. Tracking shows enrollment, owner, checks, workflows, actions, transport and receipt evidence. Press `u` to request fresh evidence, `o` to open the selected GitHub PR, or `a` to record the selected PR's auto-merge preference from Tracking or an inspected delivery. A configured preference, a recorded request, and a confirmed merge are separate observations.

Output and Runtime show selected worker runs and their recent events. Use `h/l` to move between runs, Tab to switch between output and worker events, `p` to pause or resume the scheduler, `c` to cancel, and `r` to retry. GitHub shows quota gauges and forecasts, with a shared scale for the per-minute request and cache history. Issues shows the versioned brief, waiting state, and current assignment. Issue approvals and answers use the [issue CLI](issues.md#commands).

A failed observation leaves cached content visible and the connection or refresh error visible. Activity reconciliation uses the selected saved operation ID and reports request acceptance while awaiting evidence. See the [activity guide](activity.md) and [scheduler guide](polling-and-auto-merge.md).
