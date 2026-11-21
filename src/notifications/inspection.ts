import { NoticeSubjectKind } from "../security/notifications.js";
import { create } from "@bufbuild/protobuf";
import { GetActionResponseSchema } from "../gen/octomanager/v2/tracking_pb.js";
import { wireAction } from "../tracking/rpc.js";
import { wireAssessment } from "../assessments/rpc.js";
import type { TrackingStore } from "../tracking/store.js";
import type { AssessmentStore } from "../assessments/store.js";

export function inspectFindings(
  tracking: TrackingStore,
  assessments: AssessmentStore,
  messageIds: string[],
  full: boolean,
) {
  const actions = new Set<string>();
  return messageIds.flatMap((id) => {
    const message = tracking.inbox.get(id);
    if (message === undefined)
      throw new Error("Frozen notification member not found");
    const actionId =
      message.actionId !== ""
        ? message.actionId
        : message.notice?.subject?.kind === NoticeSubjectKind.Action
          ? message.notice.subject.id
          : undefined;
    if (actionId === undefined || actions.has(actionId)) return [];
    actions.add(actionId);
    const assessment =
      message.notice?.assessmentId === undefined
        ? undefined
        : assessments.get(message.notice.assessmentId);
    return [
      create(GetActionResponseSchema, {
        action: wireAction(tracking.action(actionId), full),
        ...(assessment === undefined
          ? {}
          : { assessment: wireAssessment(assessment, full) }),
      }),
    ];
  });
}
