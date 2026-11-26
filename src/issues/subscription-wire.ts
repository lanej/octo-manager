import { IssueNotificationEventKind } from "../gen/octomanager/v2/issues_pb.js";
import { IssueNotificationKind } from "./contracts.js";
import type { IssueNotificationEvidence, IssueSubscription } from "./subscriptions.js";
const kinds: Record<IssueNotificationKind, IssueNotificationEventKind> = {
  title: IssueNotificationEventKind.TITLE,
  description: IssueNotificationEventKind.DESCRIPTION,
  comment: IssueNotificationEventKind.COMMENT,
  closed: IssueNotificationEventKind.CLOSED,
  reopened: IssueNotificationEventKind.REOPENED,
  coordinator: IssueNotificationEventKind.COORDINATOR,
  refresh_failure: IssueNotificationEventKind.REFRESH_FAILURE,
  refresh_recovery: IssueNotificationEventKind.REFRESH_RECOVERY,
};
export function wireIssueNotificationKind(kind: IssueNotificationKind): IssueNotificationEventKind {
  return kinds[kind];
}
export function issueNotificationKind(kind: IssueNotificationEventKind): IssueNotificationKind {
  switch (kind) {
    case IssueNotificationEventKind.TITLE:
      return IssueNotificationKind.Title;
    case IssueNotificationEventKind.DESCRIPTION:
      return IssueNotificationKind.Description;
    case IssueNotificationEventKind.COMMENT:
      return IssueNotificationKind.Comment;
    case IssueNotificationEventKind.CLOSED:
      return IssueNotificationKind.Closed;
    case IssueNotificationEventKind.REOPENED:
      return IssueNotificationKind.Reopened;
    case IssueNotificationEventKind.COORDINATOR:
      return IssueNotificationKind.Coordinator;
    case IssueNotificationEventKind.REFRESH_FAILURE:
      return IssueNotificationKind.RefreshFailure;
    case IssueNotificationEventKind.REFRESH_RECOVERY:
      return IssueNotificationKind.RefreshRecovery;
    case IssueNotificationEventKind.UNSPECIFIED:
      throw new Error("Issue event kind required");
    default:
      throw new Error("Unsupported issue event kind");
  }
}
export function wireIssueSubscription(value: IssueSubscription) {
  return { ...value, events: value.events.map(wireIssueNotificationKind) };
}
export function wireIssueEvidence(value: IssueNotificationEvidence) {
  return {
    ...value,
    kind: wireIssueNotificationKind(value.kind),
    atMs: BigInt(value.at),
  };
}
