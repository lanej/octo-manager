import {
  ActivityName,
  ActivityOutcome,
} from "../gen/octomanager/v2/activity_pb.js";
import {
  DomainMergeOverviewOperationsItemKind as OperationKind,
  DomainMergeOverviewOperationsItemPhase as OperationPhase,
  DomainMergeOverviewOperationsItemState as OperationState,
  type DomainMergeOverviewOperationsItem as Operation,
} from "../gen/octomanager/v2/domain_pb.js";
import {
  GitHubForecastState,
  RefreshState,
  type GitHubRateBudget,
} from "../gen/octomanager/v2/github_pb.js";
import { IssueStage, IssueWaiting } from "../gen/octomanager/v2/issues_pb.js";
import { RepairState } from "../gen/octomanager/v2/repairs_pb.js";
import {
  JobStatus,
  SchedulerState,
  WorkerState,
  type Snapshot,
  type ListActivityResponse,
  type WatchDashboardResponse,
} from "../gen/octomanager/v2/scheduler_pb.js";
import {
  ActionState,
  CheckWatchState,
  DeliveryState,
  TrackingState,
  type TrackedPullRequest,
} from "../gen/octomanager/v2/tracking_pb.js";

import {
  dashboardLink,
  markdownReference,
  type DashboardLink,
} from "./links.js";

export const primary = ["Attention", "Deliveries", "Activity"] as const;
export const diagnostics = [
  "Reviews",
  "Output",
  "Runtime",
  "Tracking",
  "GitHub",
  "Issues",
] as const;
export type Screen = (typeof primary)[number] | (typeof diagnostics)[number];
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";
type DetailFact = {
  label: string;
  value: string;
};
export type DetailLine =
  | string
  | (DetailFact & { kind: "pill"; tone: StatusTone })
  | (DetailFact & { kind: "link"; link: DashboardLink });

export interface DeliveryPresentation {
  subject: string;
  title?: string;
  condition: string;
  group: "Needs intervention" | "In progress" | "Delivered / closed";
  next: string;
  observed: string;
  identity: DetailLine[];
  verification: DetailLine[];
  authority: DetailLine[];
  feedback: DetailLine[];
}
export interface RecordView {
  id: string;
  label: string;
  detail: string;
  delivery?: DeliveryPresentation;
  url?: string;
  prId?: string;
  jobId?: string;
  operationId?: string;
  markdown?: string;
  log?: string;
}

export function safeText(value: string): string {
  return value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (character) =>
    character === "\n" ? "\n" : " ",
  );
}

export function enumName(
  names: Partial<Record<number, string>>,
  value?: number,
): string {
  return value === undefined
    ? "unknown"
    : (names[value]?.toLowerCase().replaceAll("_", " ") ?? "unknown");
}

function field(
  name: string,
  value: string | bigint | number | undefined,
  fallback = "Unknown",
): string {
  return `${name}: ${value === undefined || value === "" ? fallback : String(value)}`;
}

function pill(
  label: string,
  value: string | undefined,
  tone: StatusTone,
): DetailLine {
  return {
    kind: "pill",
    label,
    value: value === undefined || value === "" ? "Unknown" : value,
    tone,
  };
}

function reference(label: string, url: string): DetailLine {
  const link = dashboardLink(url);
  return link === undefined
    ? field(label, url === "" ? undefined : "Unsupported URL")
    : { kind: "link", label, value: link.label, link };
}

const monitoringTones: Record<TrackingState, StatusTone> = {
  [TrackingState.UNSPECIFIED]: "neutral",
  [TrackingState.WATCHING]: "success",
  [TrackingState.DRAINING]: "warning",
  [TrackingState.ARCHIVED]: "neutral",
  [TrackingState.DISABLED]: "neutral",
};

const transportTones: Record<DeliveryState, StatusTone> = {
  [DeliveryState.UNSPECIFIED]: "neutral",
  [DeliveryState.PENDING]: "info",
  [DeliveryState.SENDING]: "info",
  [DeliveryState.DELIVERED]: "success",
  [DeliveryState.UNCERTAIN]: "warning",
  [DeliveryState.UNAVAILABLE]: "danger",
  [DeliveryState.CANCELLED]: "neutral",
};

const dispositionTones: Record<ActionState, StatusTone> = {
  [ActionState.UNSPECIFIED]: "neutral",
  [ActionState.OPEN]: "warning",
  [ActionState.ACKNOWLEDGED]: "info",
  [ActionState.WORKING]: "info",
  [ActionState.RESOLVED]: "success",
  [ActionState.SUPERSEDED]: "neutral",
};

function enumTone(
  tones: Partial<Record<number, StatusTone>>,
  value?: number,
): StatusTone {
  return value === undefined ? "neutral" : (tones[value] ?? "neutral");
}

function prStateTone(state: string | undefined): StatusTone {
  if (state === "merged") return "success";
  if (state === "open") return "info";
  return "neutral";
}

function mergeProgressTone(state: string | undefined): StatusTone {
  switch (state) {
    case "uncertain":
    case "waiting_owner":
      return "warning";
    case "blocked":
      return "danger";
    case "merged":
      return "success";
    case "waiting":
    case "preparing":
    case "waiting_checks":
    case "ready":
    case "merging":
      return "info";
    case undefined:
    default:
      return "neutral";
  }
}

export function prLabel(url: string): string {
  return dashboardLink(url)?.label ?? url;
}

export function browserURL(value: string): string | undefined {
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/u.test(value))
    return value;
  return undefined;
}

function jobURL(job: Snapshot["jobs"][number]): string | undefined {
  const task = job.task?.kind;
  return task?.case === "summarizePullRequest" ? task.value.url : undefined;
}

function subjectRecords(snapshot: Snapshot, trackedOnly: boolean) {
  const subjects = new Map<string, TrackedPullRequest | undefined>();
  for (const pr of snapshot.tracking?.prs ?? []) subjects.set(pr.url, pr);
  if (!trackedOnly)
    for (const job of snapshot.jobs) {
      const url = jobURL(job);
      if (url !== undefined && !subjects.has(url)) subjects.set(url, undefined);
    }
  return subjects;
}

function latest<T extends { id: string; updatedAtMs: bigint }>(
  items: T[],
): T | undefined {
  return items.reduce<T | undefined>(
    (previous, item) =>
      previous === undefined ||
      item.updatedAtMs > previous.updatedAtMs ||
      (item.updatedAtMs === previous.updatedAtMs && item.id > previous.id)
        ? item
        : previous,
    undefined,
  );
}

type Condition = [rank: number, label: string, next: string];

function prRecord(
  snapshot: Snapshot,
  url: string,
  pr: TrackedPullRequest | undefined,
  time: (value?: bigint) => string,
): { rank: number; record: RecordView } {
  const tracking = snapshot.tracking;
  const merge = snapshot.mergeStatuses.find((entry) => entry.prId === pr?.id);
  const observation = pr?.observation;
  const actions =
    tracking?.actions.filter((action) => action.prId === pr?.id) ?? [];
  const repairs = snapshot.repairs.filter((repair) => repair.prId === pr?.id);
  const activeRepair = latest(
    repairs.filter(
      (repair) =>
        repair.state === RepairState.UNCERTAIN ||
        observation?.headSha === undefined ||
        observation.headSha === "" ||
        repair.originalHead === "" ||
        [repair.originalHead, repair.resultHead].includes(observation.headSha),
    ),
  );
  const conditions: Condition[] = [];
  if (pr === undefined)
    conditions.push([
      60,
      "Not enrolled for tracking",
      "Enroll from the owning session.",
    ]);
  if (merge?.state === "merged" || observation?.lifecycle === "merged")
    conditions.push([
      -2,
      "Merge confirmed",
      "Inspect the delivery receipt. Task acceptance is separate.",
    ]);
  if (observation?.lifecycle === "closed")
    conditions.push([-1, "PR closed", "Inspect retained delivery history."]);
  if (merge?.state === "uncertain")
    conditions.push([
      0,
      "Merge outcome unknown",
      "Reconcile the saved merge operation in Activity.",
    ]);
  if (merge?.chainState === "cancelled" && merge.state !== "cancelled")
    conditions.push([
      1,
      "Stopped with reconciliation pending",
      "Confirm the in-flight outcome.",
    ]);
  if (activeRepair?.state === RepairState.UNCERTAIN)
    conditions.push([
      2,
      "Repair outcome unknown",
      "Inspect the saved repair before retrying.",
    ]);
  if (
    pr !== undefined &&
    (!pr.enabled ||
      pr.trackingState === TrackingState.ARCHIVED ||
      pr.trackingState === TrackingState.DISABLED)
  )
    conditions.push([
      50,
      "Monitoring stopped",
      "Inspect enrollment and retained evidence.",
    ]);
  if (merge?.chainState === "paused")
    conditions.push([
      40,
      "Merge chain paused",
      "Inspect the chain before resuming.",
    ]);
  if (merge?.state === "cancelled")
    conditions.push([
      45,
      "Automatic merge stopped",
      "Inspect the open PR before authorizing further work.",
    ]);
  if (pr?.ownerAgentId === "")
    conditions.push([
      20,
      "Responsible owner missing",
      "Assign the owning session.",
    ]);
  if (
    activeRepair?.state === RepairState.FAILED ||
    activeRepair?.state === RepairState.BLOCKED
  )
    conditions.push([
      25,
      "Repair needs attention",
      "Inspect the retained blocker and repair attempt.",
    ]);
  if (merge?.state === "blocked")
    conditions.push([
      30,
      "Merge blocked",
      "Inspect the coordinator's reported blocker.",
    ]);
  const actionDetails = actions.flatMap((action): DetailLine[] => {
    const routes =
      tracking?.deliveries.filter(
        (delivery) => delivery.actionId === action.id,
      ) ?? [];
    const ownerDelivery = latest(
      routes.filter(
        (delivery) => delivery.recipientAgentId === pr?.ownerAgentId,
      ),
    );
    const current =
      action.evidenceHeadSha === "" ||
      action.evidenceHeadSha === observation?.headSha;
    if (
      current &&
      action.state === ActionState.OPEN &&
      action.blocker.case !== "checkResults"
    ) {
      if (ownerDelivery?.state === DeliveryState.UNCERTAIN)
        conditions.push([
          10,
          "Feedback delivery uncertain",
          "Reconcile before sending the feedback again.",
        ]);
      if (
        ownerDelivery?.state === DeliveryState.UNAVAILABLE ||
        ownerDelivery?.state === DeliveryState.CANCELLED
      )
        conditions.push([
          20,
          "Owner delivery unavailable",
          "Inspect the responsible session and delivery outcome.",
        ]);
      if (ownerDelivery?.state === DeliveryState.DELIVERED)
        conditions.push([
          101,
          ownerDelivery.acknowledgedAtMs === undefined
            ? "Feedback delivered"
            : "Owner received feedback",
          "Await owner assessment.",
        ]);
    }
    if (
      current &&
      (action.state === ActionState.WORKING ||
        action.state === ActionState.ACKNOWLEDGED)
    )
      conditions.push([
        100,
        `Owner ${enumName(ActionState, action.state)}`,
        "Await disposition and observed resolution.",
      ]);
    return [
      "",
      `• ${action.summary}`,
      ...(action.blocker.case === "reviewFeedback"
        ? [
            field("Review source", action.blocker.value.source),
            field("Reviewer", action.blocker.value.author),
          ]
        : []),
      field("Evidence head", action.evidenceHeadSha),
      reference("Evidence", action.evidenceUrl),
      ...routes.flatMap((delivery) => [
        field(
          "Recipient",
          tracking?.agents.find(
            (agent) => agent.id === delivery.recipientAgentId,
          )?.target?.label ?? delivery.recipientAgentId,
        ),
        pill(
          "Transport",
          enumName(DeliveryState, delivery.state),
          enumTone(transportTones, delivery.state),
        ),
        delivery.acknowledgedAtMs !== undefined
          ? pill("Receipt", "Acknowledged", "success")
          : delivery.messageSequence === undefined
            ? pill("Receipt", "Unavailable", "neutral")
            : pill("Receipt", "Awaiting acknowledgment", "warning"),
        ...(delivery.acknowledgedAtMs === undefined
          ? []
          : [field("Receipt recorded", time(delivery.acknowledgedAtMs))]),
      ]),
      pill(
        "Owner disposition",
        enumName(ActionState, action.state),
        enumTone(dispositionTones, action.state),
      ),
    ];
  });
  if (pr?.refreshError !== undefined)
    conditions.push([
      102,
      "Observation refresh failed",
      "Retained evidence may be stale.",
    ]);
  if (observation === undefined)
    conditions.push([
      110,
      "Awaiting first observation",
      "Wait for coordinator observation.",
    ]);
  if (merge !== undefined && merge.state !== "")
    conditions.push([
      105,
      `Merge ${merge.state.replaceAll("_", " ")}`,
      merge.detail,
    ]);
  conditions.push([
    190,
    "Monitoring PR",
    "Await feedback or a guarded merge decision.",
  ]);
  const [rank, condition, next] = conditions.toSorted(
    (a, b) => a[0] - b[0],
  )[0] ?? [190, "Unknown", ""];
  const owner = tracking?.agents.find((agent) => agent.id === pr?.ownerAgentId);
  const evidence = [observation?.checks, observation?.workflows].flatMap(
    (value, index): DetailLine[] => {
      const variant = value?.variant;
      const label = index === 0 ? "Checks" : "Workflows";
      if (variant?.case !== "variant1" && variant?.case !== "variant2")
        return [
          pill(
            label,
            variant === undefined ? undefined : "Incomplete",
            "neutral",
          ),
        ];
      const complete = variant.case === "variant1";
      return [
        pill(
          label,
          complete ? "complete" : "partial",
          complete ? "info" : "warning",
        ),
        ...(variant.value.value?.items.map(
          (check) =>
            `  ${check.name ?? "Unknown check"} · ${check.conclusion ?? check.status ?? "unknown"} · ${check.headSha === undefined || check.headSha === "" ? "unpinned" : check.headSha === observation?.headSha ? "current head" : "different head"}`,
        ) ?? []),
      ];
    },
  );
  return {
    rank: rank < 0 ? 200 : rank,
    record: {
      id: url,
      label: `${prLabel(url)} · ${condition}`,
      url,
      ...(pr === undefined ? {} : { prId: pr.id }),
      delivery: {
        subject: prLabel(url),
        condition,
        group:
          rank < 0
            ? "Delivered / closed"
            : rank < 100
              ? "Needs intervention"
              : "In progress",
        next,
        observed: time(observation?.observedAtMs),
        identity: [
          field(
            "Owner",
            owner?.target?.label ?? pr?.ownerAgentId,
            "Unassigned",
          ),
          pill(
            "Monitoring",
            enumName(TrackingState, pr?.trackingState),
            enumTone(monitoringTones, pr?.trackingState),
          ),
          pill(
            "PR state",
            observation?.lifecycle,
            prStateTone(observation?.lifecycle),
          ),
          field("Head", observation?.headSha),
          field("PR base", observation?.baseSha),
          observation?.targetBase?.ref === undefined ||
          observation.targetBase.ref === ""
            ? field("Target branch", undefined)
            : pill(
                "Target branch",
                observation.targetBase.ref.replace(/^refs\/heads\//u, ""),
                "accent",
              ),
          field("Target head", observation?.targetBase?.sha),
        ],
        verification: [
          pill(
            "Mergeability",
            observation?.mergeability,
            observation?.mergeability === "mergeable"
              ? "success"
              : observation?.mergeability === "conflicting"
                ? "danger"
                : "neutral",
          ),
          ...evidence,
          field("Refresh error", pr?.refreshError, "None reported"),
        ],
        authority: [
          pill(
            "Auto merge",
            merge?.autoMerge === true ? "On" : "Off",
            merge?.autoMerge === true ? "info" : "neutral",
          ),
          field("Authority source", merge?.autoMergeSource),
          pill(
            "Coordinator progress",
            merge?.state.replaceAll("_", " "),
            mergeProgressTone(merge?.state),
          ),
          pill(
            "Merge result",
            rank === -2
              ? "Confirmed"
              : merge?.state === "uncertain"
                ? "Unconfirmed"
                : "No confirmation in stored evidence",
            rank === -2
              ? "success"
              : merge?.state === "uncertain"
                ? "warning"
                : "neutral",
          ),
          ...(merge?.prerequisiteUrls.map((address) =>
            reference("Requires merge", address),
          ) ?? []),
        ],
        feedback:
          actionDetails.length === 0
            ? ["No retained actions for this PR."]
            : actionDetails.slice(1),
      },
      detail: [
        ...repairs.flatMap((repair) => [
          "",
          field("Repair state", enumName(RepairState, repair.state)),
          field("Repair", repair.id),
          field("Target", repair.targetSha),
          field("Result", repair.resultHead),
        ]),
        ...(tracking?.checkWatches
          .filter((watch) => watch.prId === pr?.id)
          .flatMap((watch) => {
            const evidence = watch.evidence?.variant;
            const count =
              evidence?.case === "variant1" || evidence?.case === "variant2"
                ? evidence.value.value?.items.length
                : undefined;
            return [
              "",
              field("Check watch", watch.id),
              field("State", enumName(CheckWatchState, watch.state)),
              field("Pinned head", watch.headSha),
              field("Generation", watch.generation),
              field(
                "Coverage",
                evidence?.case === "variant1"
                  ? "Complete"
                  : evidence?.case === "variant2"
                    ? "Partial"
                    : "Unavailable",
              ),
              field("Observed checks", count),
              field("Replacement head", watch.replacementHeadSha),
            ];
          }) ?? []),
        ...snapshot.recentEvents
          .filter((event) => event.prId === pr?.id && pr !== undefined)
          .map((event) => eventLine(event, time)),
      ].join("\n"),
    },
  };
}

type Time = (value?: bigint) => string;

export function eventLine(event: Snapshot["recentEvents"][number], time: Time) {
  return `${time(event.atMs)} · ${event.kind} · ${event.detail}`;
}

export function activityRecords(
  page: ListActivityResponse | undefined,
  operations: readonly Operation[],
  snapshot: Snapshot,
  time: Time,
): RecordView[] {
  const saved = operations.map((operation): RecordView => {
    const url = snapshot.tracking?.prs.find(
      (pr) => pr.id === operation.prId,
    )?.url;
    const eligible =
      operation.state === OperationState.UNCERTAIN &&
      ((operation.kind === OperationKind.MERGE &&
        operation.phase === OperationPhase.MERGING) ||
        (operation.kind === OperationKind.PREPARE &&
          operation.phase === OperationPhase.PUSHING));
    return {
      id: `operation:${operation.id ?? operation.requestId ?? "unknown"}`,
      label: `${enumName(OperationKind, operation.kind)} · ${enumName(OperationState, operation.state)}`,
      ...(url === undefined ? {} : { url }),
      ...(eligible && operation.id !== undefined
        ? { operationId: operation.id }
        : {}),
      detail: [
        field("Saved operation", operation.id),
        field("Request", operation.requestId),
        field("State", enumName(OperationState, operation.state)),
        field("Phase", enumName(OperationPhase, operation.phase)),
        field("PR", url),
        field("Head", operation.head),
        field("Target", operation.baseRef),
        field("Target head", operation.baseSha),
        field("Result head", operation.resultHead),
        field("Merge commit", operation.mergeCommit),
        field("Detail", operation.detail),
        field("Requested", time(operation.createdAt)),
        field("Last evidence", time(operation.updatedAt)),
      ].join("\n"),
    };
  });
  const reports = (page?.activities ?? []).map((activity) => {
    const report = activity.report;
    return {
      sequence: activity.sequence,
      id: `report:${String(activity.sequence)}`,
      label: `${enumName(ActivityName, report?.name)} · ${enumName(ActivityOutcome, report?.outcome)} reported`,
      ...(report?.prUrl === undefined ? {} : { url: report.prUrl }),
      detail: [
        field("Reported", time(activity.recordedAtMs)),
        field("By", report?.actor?.label ?? report?.actor?.sessionId),
        field("Outcome reported", enumName(ActivityOutcome, report?.outcome)),
        field("Detail", report?.detail),
        field("Evidence", report?.evidenceUrl),
      ].join("\n"),
    };
  });
  const events = (page?.events ?? []).map((event) => ({
    sequence: event.sequence,
    id: `event:${String(event.sequence)}`,
    label: event.kind,
    detail: eventLine(event, time),
    ...(event.actionContext === undefined
      ? {}
      : { url: event.actionContext.prUrl }),
  }));
  return [
    ...saved,
    ...[...reports, ...events].sort((a, b) =>
      a.sequence > b.sequence ? -1 : 1,
    ),
  ];
}

function quota(
  name: string,
  budget: GitHubRateBudget | undefined,
  sampledAt: bigint,
  time: Time,
) {
  if (budget === undefined) return field(name, "Awaiting quota evidence");
  const filled =
    budget.limit === 0
      ? 0
      : Math.min(28, Math.ceil((budget.remaining / budget.limit) * 28));
  return [
    name + " quota",
    field(
      name,
      `${String(budget.remaining)} / ${String(budget.limit)}${sampledAt >= budget.resetAtMs ? " · observation expired" : ""}`,
    ),
    "▮".repeat(filled) + "░".repeat(28 - filled),
    field("Reset", time(budget.resetAtMs)),
    field("Forecast", enumName(GitHubForecastState, budget.forecast?.state)),
    field("Forecast evidence", budget.forecast?.reason),
  ].join("\n");
}

function minuteChart(
  minutes: NonNullable<Snapshot["githubUsage"]>["minutes"],
): string[] {
  const levels = "▁▂▃▄▅▆▇█";
  const metrics = ["rest", "graphql", "cacheReuses"] as const;
  const maximum = minutes.reduce(
    (peak, minute) =>
      metrics.reduce(
        (value, metric) => (minute[metric] > value ? minute[metric] : value),
        peak,
      ),
    0n,
  );
  if (minutes.length === 0 || maximum === 0n)
    return ["No minute traffic recorded"];
  return [
    field("Scale", `0–${String(maximum)} per minute · oldest → newest`),
    ...metrics.map(
      (metric) =>
        (metric === "cacheReuses"
          ? "Cache:"
          : metric === "graphql"
            ? "GraphQL:"
            : "REST:"
        ).padEnd(10) +
        minutes
          .map((minute) =>
            minute[metric] === 0n
              ? "·"
              : levels.at(Number((minute[metric] * 7n) / maximum)),
          )
          .join(""),
    ),
  ];
}

function githubRows(
  snapshot: Snapshot,
  time: Time,
  hours: number,
): RecordView[] {
  const usage = snapshot.githubUsage;
  const schedule = snapshot.githubScheduler;
  if (usage === undefined) return [];
  return [
    {
      id: "github",
      label: "GitHub reads and quota",
      detail: [
        quota("REST", usage.rest, usage.sampledAtMs, time),
        "",
        quota("GraphQL points", usage.graphql, usage.sampledAtMs, time),
        "",
        "Scheduler activity",
        field("Requests", usage.requests),
        field("Confirmed cache reuses", usage.cacheReuses),
        field("Rate limits", usage.rateLimits),
        field("REST retry", time(usage.restRetryAtMs)),
        field("GraphQL retry", time(usage.graphqlRetryAtMs)),
        field("Queued requests", schedule?.queuedRequests),
        field("Next dispatch", time(schedule?.nextDispatchAtMs)),
        "",
        "Recent minutes · REST / GraphQL / cache",
        ...minuteChart(usage.minutes.slice(-30)),
        ...usage.minutes
          .slice(-60)
          .reverse()
          .map((bucket) =>
            field(
              time(bucket.startedAtMs),
              `${String(bucket.rest)} / ${String(bucket.graphql)} / ${String(bucket.cacheReuses)}`,
            ),
          ),
        "",
        "Recent hours · REST / GraphQL / cache",
        ...usage.hours
          .slice(-hours)
          .reverse()
          .map((bucket) =>
            field(
              time(bucket.startedAtMs),
              `${String(bucket.rest)} / ${String(bucket.graphql)} / ${String(bucket.cacheReuses)}`,
            ),
          ),
      ].join("\n"),
    },
  ];
}

export function records(
  screen: Screen,
  snapshot: Snapshot,
  time: Time,
  hours: number,
): RecordView[] {
  if (screen === "Activity") return [];
  if (screen === "GitHub") return githubRows(snapshot, time, hours);
  if (screen === "Issues")
    return snapshot.issues.map((issue) => ({
      id: issue.id,
      label: `${issue.title} · ${enumName(IssueStage, issue.stage)}`,
      ...(issue.prUrl === "" ? {} : { url: issue.prUrl }),
      detail: [
        issue.title,
        field("Issue", issue.reference?.url),
        field("Stage", enumName(IssueStage, issue.stage)),
        field("Waiting", enumName(IssueWaiting, issue.waiting)),
        field("Detail", issue.detail),
        field("Updated", time(issue.updatedAtMs)),
        field("Clarification due", time(issue.clarificationDueAtMs)),
        field("Assignment", issue.assignment?.role),
        field("Assignment state", issue.assignment?.state),
        field("Session", issue.assignment?.sessionId),
        field("Worker detail", issue.assignment?.detail),
        field("Brief version", issue.brief?.version),
        issue.brief?.outcome ?? "",
        issue.brief?.scope ?? "",
        ...(issue.brief?.criteria ?? []),
        ...(issue.brief?.assumptions ?? []),
        ...(issue.brief?.questions ?? []),
        ...(issue.assignment?.evidence ?? []),
      ].join("\n"),
    }));
  if (
    (screen === "Output" || screen === "Runtime") &&
    snapshot.jobs.length === 0
  )
    return [
      {
        id: "worker",
        label: "Worker runtime",
        detail: [
          field("Scheduler", enumName(SchedulerState, snapshot.scheduler)),
          field("Worker", enumName(WorkerState, snapshot.worker)),
          "No retained worker runs",
        ].join("\n"),
      },
    ];
  if (screen === "Output" || screen === "Runtime")
    return snapshot.jobs.map((job) => {
      const url = jobURL(job);
      return {
        id: job.id,
        jobId: job.id,
        ...(url === undefined ? {} : { url }),
        ...(screen === "Output" && job.resultMarkdown !== undefined
          ? { markdown: job.resultMarkdown }
          : {}),
        log: snapshot.recentEvents
          .filter((event) => event.jobId === job.id)
          .slice(-500)
          .map((event) => eventLine(event, time))
          .join("\n"),
        label: `${url === undefined ? job.id : prLabel(url)} · ${enumName(JobStatus, job.status)}`,
        detail: [
          field("Job", job.id),
          field("State", enumName(JobStatus, job.status)),
          field("Scheduler", enumName(SchedulerState, snapshot.scheduler)),
          field("Worker", enumName(WorkerState, snapshot.worker)),
          field("Error", job.error),
          ...job.attempts.map(
            (attempt) =>
              `Attempt ${String(attempt.number)} · ${time(attempt.startedAtMs)} → ${time(attempt.endedAtMs)} · ${attempt.error ?? ""}`,
          ),
          ...(screen === "Output"
            ? job.resultMarkdown === undefined
              ? ["", "Awaiting worker output"]
              : []
            : [
                "",
                "Allowed transitions",
                ...snapshot.allowedTransitions.map(
                  (item) =>
                    `${enumName(JobStatus, item.from)} → ${enumName(JobStatus, item.to)}`,
                ),
              ]),
        ].join("\n"),
      };
    });
  return [...subjectRecords(snapshot, screen === "Tracking")]
    .map(([url, pr]) => prRecord(snapshot, url, pr, time))
    .filter(({ rank }) => screen !== "Attention" || rank < 100)
    .sort((a, b) =>
      a.rank === b.rank
        ? a.record.id.localeCompare(b.record.id)
        : a.rank - b.rank,
    )
    .map(({ record }) => record);
}

export function refreshDetail(
  frame: WatchDashboardResponse | undefined,
  time: Time,
) {
  const status = frame?.refresh;
  return [
    field("Refresh", enumName(RefreshState, status?.state)),
    field("Next eligible", time(status?.dueAtMs)),
    field("Last attempt", time(status?.lastAttemptAtMs)),
    field("Last refresh error", status?.lastError, "None reported"),
  ].join("\n");
}

export function reviewDetail(
  frame: WatchDashboardResponse | undefined,
  record: RecordView,
  time: Time,
) {
  const review =
    frame?.pullRequest?.url === record.url ? frame?.pullRequest : undefined;
  return [
    refreshDetail(frame, time),
    review === undefined
      ? "Awaiting cached reviews"
      : [
          review.title,
          field("Reviewed head", review.headSha),
          field("Observed", time(review.observedAtMs)),
          ...(review.mayHaveMoreMessages ? ["Review history is partial."] : []),
          ...review.messages.flatMap((message) => [
            "",
            `${message.author} · ${message.kind} · ${message.state} · ${time(message.atMs)}`,
            field("Source", markdownReference(message.url)),
            field("Revision", message.commitSha),
            message.path === ""
              ? ""
              : field(
                  "Location",
                  `${message.path}:${String(message.line ?? "?")}`,
                ),
            message.bodyMarkdown,
            ...(message.bodyTruncated ? ["Source body was truncated."] : []),
          ]),
        ].join("\n\n"),
  ].join("\n\n");
}
