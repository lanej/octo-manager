# Dashboard layout

The dashboard receives stored frames on the coordinator’s shared scheduling tick. View changes register interest; `u` queues a refresh while keeping cached content visible. The GitHub tab includes cadence, queued requests, next dispatch and cooldowns. See the [scheduler guide](polling-and-auto-merge.md).

Each tab declares its purpose, main content and supporting regions through Charmed’s `tui.Screen`. The Bun coordinator owns durable data and automation; the Go TUI presents its snapshot and issues explicit commands. Detaching the dashboard leaves the coordinator running.

Reviews and Tracking share PR navigation and pinned merge context. Output and Runtime share PR navigation and a worker pane. Activity, GitHub, and Issues are global workspaces. Tracking starts by default; the local conflict demo uses Runtime. Worker-run controls are available only on Output and Runtime.

Wide terminals show a PR rail beside the current workspace. Focused or expanded views give the main content the full width while retaining keyboard PR navigation. Short terminals omit the supporting worker pane explicitly. Below the minimum workspace size, the recovery view preserves `q quit`. Main content remains scrollable; it is not discarded to fit the viewport.

Tracking groups automation, ownership and observed state separately from blockers, agent actions and delivery history. These nested sections form columns only when both have enough readable width, otherwise they stack. Check watches have a separate log in Tracking, ordered newest first. The PR rail and pinned context show auto-merge configuration independently of readiness: enabled, paused, stopped with reconciliation still pending, or manual. Confirmed closed or merged PRs show that outcome. An enabled switch on a merged entry records its configuration; it does not establish who performed the merge.

GitHub groups REST and GraphQL budgets separately, with forecast uncertainty and observation times preserved. Traffic and cache reuse follow the budget sections. The budgets form columns on wide workspaces and stack on narrower ones.

`MergeStatus.chain_state` is an additive snapshot field, separate from entry progress in `state`. A paused chain can still contain an entry waiting for checks. No stored-state migration is needed. Coordinators that omit the field still supply configuration and entry progress; the UI cannot infer chain pause from those values.

## Issues workspace

**7 Issues** shows up to fifty stored issue summaries. Each row identifies the tracker issue, stage, and waiting condition. The selected detail shows the next action, workspace, latest agent role/state/model, PR link, and brief with acceptance criteria, assumptions and questions. `h/l` selects an issue; `j/k` scrolls. Approvals and clarification answers use the [issue CLI](issues.md#commands). A Done row reports accepted verification; inspect closure evidence before assuming the tracker is closed.

## Representative renderings

These images use the actual dashboard renderer with synthetic repository and agent data. They demonstrate layout and labeling, not a live GitHub observation. Live acceptance also exercised tab navigation, scrolling, resizing from 132 to 80 columns and clean detachment against the local coordinator. Native window capture was unavailable because the Mac was locked.

![Tracking at 160 columns with explicit auto-merge status, ownership and actions](images/dashboard-tracking.png)

![Scheduler cadence, GitHub budgets and traffic at 160 columns](images/dashboard-github.png)

![Cached review feedback remains visible while a scheduler refresh is queued](images/dashboard-cached-reviews.png)

![Issues workspace at 132 columns with a versioned brief and clarification question](images/dashboard-issues.png)

![Issues workspace at 80 columns with wrapped summary and retained brief](images/dashboard-issues-narrow.png)
