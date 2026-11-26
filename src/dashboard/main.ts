import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ConnectError } from "@connectrpc/connect";
import { createCliRenderer } from "@opentui/core";
import { schedulerClient } from "../client.js";
import {
  DomainMergeOverviewOperationsItemState as OperationState,
  type DomainMergeOverviewOperationsItem,
} from "../gen/octomanager/v2/domain_pb.js";
import {
  SchedulerState,
  type JobEvent,
  type ListActivityResponse,
  type Snapshot,
  type WatchDashboardResponse,
} from "../gen/octomanager/v2/scheduler_pb.js";
import {
  activityRecords,
  eventLine,
  browserURL,
  records,
  refreshDetail,
  reviewDetail,
  type RecordView,
} from "./records.js";
import { dashboardTheme, dashboardView } from "./view.js";

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    theme: { type: "string" },
    timezone: { type: "string" },
    "github-hours": { type: "string" },
  },
});
const directory = resolve(
  values.state ??
    process.env["OCTO_MANAGER_STATE"] ??
    join(homedir(), ".local", "state", "octo-manager"),
);
const theme = dashboardTheme(values.theme);
const hourValue = values["github-hours"] ?? "24";
const hours = Number(hourValue);
if (!/^\d+$/u.test(hourValue) || hours < 1 || hours > 168)
  throw new Error("GitHub hours must be between 1 and 168.");
const formatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
  ...(values.timezone === undefined || values.timezone === "local"
    ? {}
    : { timeZone: values.timezone }),
});
const time = (value?: bigint) =>
  value === undefined || value === 0n
    ? "Unknown"
    : formatter.format(Number(value));
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error("Dashboard needs an interactive terminal.");

const stop = new AbortController();
const stopped = () => stop.signal.aborted;
const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  useMouse: false,
  consoleMode: "disabled",
  onDestroy: () => {
    stop.abort();
  },
});

let client = schedulerClient(directory);
let snapshot: Snapshot | undefined;
let frame: WatchDashboardResponse | undefined;
let interest = { url: "", reviews: false };
let request = new AbortController();
let acceptedRequest: AbortController | undefined;
let page: ListActivityResponse | undefined;
let operations: readonly DomainMergeOverviewOperationsItem[] = [];
let pageCursors: bigint[] = [0n];
let retryPage: bigint[] | undefined;
let pageSequence: bigint | undefined;
let activityError = "";
let reading = false;
let workerHistory:
  | { instance: string; job: string; through: bigint; events: JobEvent[] }
  | undefined;
let readingWorker = false;
let pending = false;
let connection = "Connecting";
let notice = "";

const view = dashboardView(
  renderer,
  {
    quit() {
      renderer.destroy();
    },
    changed() {
      repaint();
      updateInterest();
      queueActivity();
    },
    action(key) {
      void command(key).catch((error: unknown) => {
        notice = error instanceof Error ? error.message : String(error);
        repaint();
      });
    },
  },
  theme,
);

function listing(): RecordView[] {
  if (snapshot === undefined) return [];
  return view.screen === "Activity"
    ? activityRecords(page, operations, snapshot, time)
    : records(view.screen, snapshot, time, hours);
}

function repaint() {
  let rows = listing();
  const history = workerHistory;
  if (history !== undefined && history.instance === snapshot?.instanceId)
    rows = rows.map((row) =>
      row.jobId === history.job
        ? {
            ...row,
            log: history.events
              .map((event) => eventLine(event, time))
              .join("\n"),
          }
        : row,
    );
  const selected = view.selected() ?? rows[0];
  const reviews =
    view.screen === "Reviews" ||
    (view.inspecting &&
      (view.screen === "Attention" || view.screen === "Deliveries"));
  if (selected !== undefined && (reviews || view.screen === "Tracking")) {
    const selectedFrame = interest.url === selected.url ? frame : undefined;
    rows = rows.map((row) => {
      if (row.id !== selected.id) return row;
      if (reviews)
        return {
          ...row,
          ...(row.delivery === undefined ||
          selectedFrame?.pullRequest?.title === undefined
            ? {}
            : {
                delivery: {
                  ...row.delivery,
                  title: selectedFrame.pullRequest.title,
                },
              }),
          detail: view.screen === "Reviews" ? row.label : row.detail,
          markdown: reviewDetail(
            interest.reviews ? selectedFrame : undefined,
            row,
            time,
          ),
        };
      return {
        ...row,
        detail: `${row.detail}\n\n${refreshDetail(selectedFrame, time)}`,
      };
    });
  }
  view.update(
    rows,
    connection,
    view.screen === "Activity" && activityError !== "" ? activityError : notice,
  );
}

function updateInterest() {
  const url = view.selected()?.url ?? "";
  const reviews =
    view.screen === "Reviews" ||
    (view.inspecting &&
      (view.screen === "Attention" || view.screen === "Deliveries"));
  const interestedURL = reviews || view.screen === "Tracking" ? url : "";
  if (interestedURL === interest.url && reviews === interest.reviews) return;
  interest = { url: interestedURL, reviews };
  frame = undefined;
  request.abort();
  request = new AbortController();
}

function queueActivity() {
  Promise.all([loadActivity(), loadWorker()]).catch((error: unknown) => {
    notice = error instanceof Error ? error.message : String(error);
    if (!stopped()) repaint();
  });
}

async function loadWorker(force = false) {
  const current = snapshot;
  const job = view.selected()?.jobId;
  if (
    readingWorker ||
    current === undefined ||
    job === undefined ||
    connection !== "Live"
  )
    return;
  const cache =
    workerHistory?.instance === current.instanceId && workerHistory.job === job
      ? workerHistory
      : undefined;
  if (!force && cache?.through === current.sequence) return;
  readingWorker = true;
  try {
    let cursor = cache?.events.at(-1)?.sequence ?? 0n;
    let events = cache?.events ?? [];
    while (
      !stopped() &&
      snapshot?.instanceId === current.instanceId &&
      view.selected()?.jobId === job
    ) {
      const response = await client.listEvents(
        { jobId: job, afterSequence: cursor },
        { signal: stop.signal },
      );
      if (
        stopped() ||
        snapshot.instanceId !== current.instanceId ||
        view.selected()?.jobId !== job
      )
        return;
      events = [...events, ...response.events].slice(-500);
      const next = response.events.at(-1)?.sequence ?? cursor;
      if (response.events.length < 200 || next >= current.sequence) break;
      if (next <= cursor)
        throw new Error("Worker history cursor did not advance");
      cursor = next;
    }
    workerHistory = {
      instance: current.instanceId,
      job,
      through: current.sequence,
      events,
    };
    repaint();
  } catch (error) {
    if (
      !stopped() &&
      snapshot?.instanceId === current.instanceId &&
      view.selected()?.jobId === job
    ) {
      notice = `Worker history unavailable · ${error instanceof Error ? error.message : String(error)}`;
      repaint();
    }
  } finally {
    readingWorker = false;
  }
}

async function loadActivity(cursors?: bigint[]) {
  const current = snapshot;
  if (
    view.screen !== "Activity" ||
    connection !== "Live" ||
    current === undefined ||
    reading
  )
    return;
  if (
    cursors === undefined &&
    (activityError !== "" ||
      pageCursors.length > 1 ||
      pageSequence === current.sequence)
  )
    return;
  reading = true;
  const target = cursors ?? pageCursors;
  const before = target.at(-1) ?? 0n;
  try {
    const [history, result] = await Promise.all([
      client.listActivity(
        { beforeSequence: before, limit: 50 },
        { signal: stop.signal },
      ),
      client.inspectMergeChains({}, { signal: stop.signal }),
    ]);
    if (snapshot?.instanceId !== current.instanceId) return;
    if (
      history.events.length + history.activities.length > 50 ||
      (before > 0n && history.nextSequence >= before) ||
      (history.hasMore && history.nextSequence === 0n)
    )
      throw new Error(
        "Activity page exceeded its bound or did not advance its cursor",
      );
    const selected = view.selected()?.id;
    const operationRank = (operation: DomainMergeOverviewOperationsItem) =>
      `operation:${operation.id ?? operation.requestId ?? "unknown"}` ===
      selected
        ? 0
        : operation.state === OperationState.UNCERTAIN
          ? 1
          : 2;
    operations = (result.overview?.operations?.items ?? [])
      .toSorted((a, b) => {
        const rank = operationRank(a) - operationRank(b);
        if (rank !== 0) return rank;
        const left = a.updatedAt ?? 0n;
        const right = b.updatedAt ?? 0n;
        return left === right ? 0 : left > right ? -1 : 1;
      })
      .slice(0, 50);
    page = history;
    pageCursors = target;
    retryPage = undefined;
    pageSequence = current.sequence;
    activityError = "";
  } catch (error) {
    if (!stopped() && snapshot?.instanceId === current.instanceId) {
      retryPage = target;
      activityError = `Activity read failed · ${error instanceof Error ? error.message : String(error)} · u Retry`;
    }
  } finally {
    reading = false;
    if (!stopped()) repaint();
  }
}

async function command(key: string) {
  if (pending || connection !== "Live" || snapshot === undefined) return;
  const current = snapshot;
  const hasFreshObservation = acceptedRequest === request;
  const report = (message: string) => {
    if (snapshot?.instanceId === current.instanceId) notice = message;
  };
  const selected = view.selected();
  const screen = view.screen;
  const options = { signal: stop.signal };
  if (screen === "Activity" && (key === "h" || key === "l" || key === "u")) {
    if (reading) return;
    if (key === "h" && page?.hasMore === true && page.nextSequence > 0n)
      await loadActivity([...pageCursors, page.nextSequence]);
    if (key === "l" && pageCursors.length > 1)
      await loadActivity(pageCursors.slice(0, -1));
    if (key === "u") await loadActivity(retryPage ?? [0n]);
    return;
  }
  if ((key === "o" || key === "g") && selected?.url !== undefined) {
    const address = browserURL(selected.url);
    if (address === undefined)
      throw new Error("This record has no supported GitHub PR URL.");
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const processHandle = Bun.spawn([opener, address], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await processHandle.exited) !== 0)
      throw new Error("Could not open the pull request.");
    return;
  }
  if (!hasFreshObservation) {
    report("Awaiting a fresh coordinator observation");
    repaint();
    return;
  }
  pending = true;
  try {
    if (
      key === "a" &&
      selected?.prId !== undefined &&
      (screen === "Tracking" ||
        (view.inspecting &&
          (screen === "Attention" || screen === "Deliveries")))
    ) {
      const entry = snapshot.mergeStatuses.find(
        (status) => status.prId === selected.prId,
      );
      const owner = snapshot.tracking?.prs.find(
        (pr) => pr.id === selected.prId,
      )?.ownerAgentId;
      if (owner === undefined || owner === "")
        throw new Error("This PR has no responsible owner.");
      await client.setAutoMerge(
        {
          pr: selected.prId,
          enabled: entry?.autoMerge !== true,
          actorId: owner,
          requestId: randomUUID(),
        },
        options,
      );
      report("Auto-merge preference recorded");
    } else if (
      key === "u" &&
      screen === "Reviews" &&
      selected?.url !== undefined
    ) {
      await client.getPullRequest(
        { url: selected.url, refresh: true },
        options,
      );
      report("Review refresh requested");
    } else if (key === "u" && selected?.prId !== undefined) {
      await client.refreshTrackedPullRequest({ id: selected.prId }, options);
      report("Tracking refresh requested");
    } else if (key === "u" && selected?.jobId !== undefined) {
      await loadWorker(true);
    } else if (key === "u") {
      request.abort();
      request = new AbortController();
    } else if (
      screen === "Activity" &&
      key === "r" &&
      selected?.operationId !== undefined &&
      activityError === ""
    ) {
      await client.reconcileMergeOperation(
        { id: selected.operationId },
        options,
      );
      report("Reconciliation requested · awaiting evidence");
      await loadActivity(pageCursors);
    } else if (screen === "Output" || screen === "Runtime") {
      if (key === "p") {
        await client.setPaused(
          { paused: snapshot.scheduler !== SchedulerState.PAUSED },
          options,
        );
        report("Scheduler preference recorded");
      } else if (key === "c" && selected?.jobId !== undefined) {
        await client.cancelJob({ id: selected.jobId }, options);
        report("Cancellation requested");
      } else if (key === "r" && selected?.jobId !== undefined) {
        await client.retryJob({ id: selected.jobId }, options);
        report("Retry requested");
      }
    }
  } catch (error) {
    if (!stopped())
      report(error instanceof Error ? error.message : String(error));
  } finally {
    pending = false;
    if (!stopped()) repaint();
  }
}

async function watch() {
  while (!stopped()) {
    const selectedRequest = request;
    const signal = AbortSignal.any([stop.signal, selectedRequest.signal]);
    try {
      for await (const update of client.watchDashboard(interest, {
        signal,
        timeoutMs: 0,
      })) {
        if (signal.aborted) break;
        if (update.snapshot === undefined) continue;
        if (snapshot?.instanceId !== update.snapshot.instanceId) {
          page = undefined;
          operations = [];
          workerHistory = undefined;
          pageCursors = [0n];
          retryPage = undefined;
          pageSequence = undefined;
          activityError = "";
          notice = "";
        }
        snapshot = update.snapshot;
        acceptedRequest = selectedRequest;
        frame = update;
        connection = "Live";
        repaint();
        updateInterest();
        queueActivity();
      }
    } catch (error) {
      if (!signal.aborted && !(error instanceof ConnectError)) throw error;
    }
    if (stopped()) break;
    if (selectedRequest.signal.aborted) continue;
    acceptedRequest = undefined;
    connection =
      snapshot === undefined
        ? "Reconnecting…"
        : "Disconnected · showing last snapshot";
    repaint();
    try {
      await setTimeout(1000, undefined, { signal: stop.signal });
    } catch (error) {
      if (!stopped()) throw error;
    }
    client = schedulerClient(directory);
  }
}

try {
  await Promise.race([watch(), renderer.closed]);
} finally {
  renderer.destroy();
  await renderer.closed;
}
process.exit(0);
