import type { Interceptor } from "@connectrpc/connect";
import { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";

// Adding an RPC requires choosing whether it can change reconciliation inputs.
const inputMethods: Readonly<Record<string, boolean>> = {
  startPerformanceCapture: false,
  getPerformanceCapture: false,
  stopPerformanceCapture: false,
  runtimeLifecycle: false,
  enrollIssue: true,
  listIssues: false,
  getIssue: false,
  updateIssue: true,
  setIssueSubscription: true,
  listIssueSubscriptions: false,
  getServerInfo: false,
  setAutoMerge: true,
  queueMergeChain: true,
  inspectMergeChains: false,
  listPRReferences: false,
  listPRDependencies: false,
  confirmPRDependency: true,
  removePRDependency: true,
  decidePRReference: true,
  setMergePolicy: true,
  setMergeReady: true,
  pauseMergeChain: true,
  resumeMergeChain: true,
  cancelMergeChain: true,
  reconcileMergeOperation: true,
  mergeAgentMessage: true,
  readNotificationMessage: true,
  getNotificationMessage: false,
  acknowledgeNotificationMessage: true,
  getAgentDigest: false,
  listAgentDigests: false,
  acknowledgeAgentDigest: true,
  getSubmission: false,
  listSubmissions: false,
  getRepositoryPolicy: false,
  listConflictCases: false,
  getConflictCase: false,
  requestRebase: true,
  listRepairs: false,
  recordActivity: false,
  listActivity: false,
  registerAgent: true,
  subscribePullRequest: true,
  unsubscribePullRequest: true,
  listPRParticipants: false,
  trackPullRequest: true,
  listTrackedPullRequests: false,
  getTrackedPullRequest: false,
  refreshTrackedPullRequest: true,
  assignPullRequest: true,
  untrackPullRequest: true,
  listActions: false,
  getAction: false,
  getAssessment: false,
  retryAssessment: true,
  acknowledgeAction: true,
  startAction: true,
  retryDelivery: true,
  listAgentMessages: false,
  acknowledgeMessage: true,
  reprofileAction: true,
  submitJob: false,
  getJob: false,
  getPullRequest: false,
  watchDashboard: false,
  getSnapshot: false,
  listEvents: false,
  watch: false,
  cancelJob: false,
  retryJob: false,
  setPaused: false,
} satisfies Record<keyof typeof SchedulerService.method, boolean>;

export function inputIntake(changed: () => void): Interceptor {
  return (next) => async (request) => {
    if (
      request.service.typeName !== SchedulerService.typeName ||
      inputMethods[request.method.localName] !== true
    )
      return next(request);
    try {
      return await next(request);
    } finally {
      // A failed request can still have committed partial progress.
      changed();
    }
  };
}
