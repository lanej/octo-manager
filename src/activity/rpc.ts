import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ActivityName as WireName,
  ActivityOutcome as WireOutcome,
  ActivityReportSchema,
  type RecordActivityRequest,
  type ListActivityRequest,
  type ActivityInput as WireInput,
} from "../gen/octomanager/v1/activity_pb.js";
import {
  ActivityName,
  ActivityOutcome,
  type ActivityReport,
  type ActivityInput,
} from "./types.js";
import type { JobEvent } from "../gen/octomanager/v1/scheduler_pb.js";
import type { ActivityStore } from "./store.js";

export const activityNames: Record<ActivityName, WireName> = {
  [ActivityName.MergePR]: WireName.MERGE_PR,
  [ActivityName.RunChecks]: WireName.RUN_CHECKS,
  [ActivityName.ResolveConflict]: WireName.RESOLVE_CONFLICT,
  [ActivityName.SummarizePR]: WireName.SUMMARIZE_PR,
  [ActivityName.NotifyAgent]: WireName.NOTIFY_AGENT,
};
export const activityOutcomes: Record<ActivityOutcome, WireOutcome> = {
  [ActivityOutcome.Attempted]: WireOutcome.ATTEMPTED,
  [ActivityOutcome.Succeeded]: WireOutcome.SUCCEEDED,
  [ActivityOutcome.Failed]: WireOutcome.FAILED,
  [ActivityOutcome.Uncertain]: WireOutcome.UNCERTAIN,
};
export function wireActivityInput(input: ActivityInput) {
  return {
    ...input,
    name: activityNames[input.name],
    outcome: activityOutcomes[input.outcome],
  };
}
function wireReport(report: ActivityReport) {
  return create(ActivityReportSchema, {
    sequence: BigInt(report.sequence),
    recordedAtMs: BigInt(report.recordedAt),
    report: wireActivityInput(report),
  });
}
function fromWire(input: WireInput | undefined): unknown {
  if (input === undefined)
    throw new ConnectError("Activity report is required", Code.InvalidArgument);
  return {
    ...input,
    name: Object.entries(activityNames).find(
      ([, value]) => value === input.name,
    )?.[0],
    outcome: Object.entries(activityOutcomes).find(
      ([, value]) => value === input.outcome,
    )?.[0],
  };
}
export function activityRoutes(
  store: ActivityStore,
  sequence: () => number,
  events: (after: number) => JobEvent[],
) {
  return {
    recordActivity(request: RecordActivityRequest) {
      try {
        return { activity: wireReport(store.record(fromWire(request.report))) };
      } catch (error) {
        if (error instanceof ConnectError) throw error;
        if (error instanceof Error && error.message.startsWith("Invalid"))
          throw new ConnectError(error.message, Code.InvalidArgument);
        if (
          error instanceof Error &&
          error.message.startsWith("Activity request ID already used")
        )
          throw new ConnectError(error.message, Code.AlreadyExists);
        throw new ConnectError("Activity recording failed", Code.Internal);
      }
    },
    listActivity(request: ListActivityRequest) {
      if (
        request.afterSequence < 0n ||
        request.afterSequence > BigInt(sequence())
      )
        throw new ConnectError(
          "Activity cursor is outside retained history",
          Code.OutOfRange,
        );
      const page = events(Number(request.afterSequence));
      const next = page.at(-1)?.sequence ?? request.afterSequence;
      return {
        activities: store
          .list(Number(request.afterSequence))
          .filter((entry) => BigInt(entry.sequence) <= next)
          .map(wireReport),
        events: page.filter(
          (entry) =>
            entry.kind !== "agent_activity" && entry.kind !== "progress",
        ),
        nextSequence: next,
        hasMore: next < BigInt(sequence()),
      };
    },
  };
}
