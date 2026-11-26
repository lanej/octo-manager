import { AssessmentService } from "../assessments/service.js";
import { IssueService } from "../issues/service.js";
import { GitHubIssueTracker } from "../issue-trackers/github.js";
import { CodexDispatcher } from "../dispatch/codex.js";
import { ManagedIssueWorkspace } from "../dispatch/workspace.js";
import { loadIssuePolicy } from "../issues/config.js";
import { trackedCodeHost } from "../issues/composition.js";
import { GitHubScheduler } from "../scheduling/service.js";
import { defaultSchedulerPolicy } from "../scheduling/contracts.js";
import { MergeService } from "../merging/service.js";
import { NotificationService } from "../tracking/notifications.js";
import { DigestService } from "../notifications/service.js";
import { managedQueuePolicy } from "../notifications/managed.js";
import { SubmissionNotifications } from "../submissions/notifications.js";
import { SubmissionService } from "../submissions/service.js";
import { RepairService } from "../repairs/service.js";
import { TrackingService } from "../tracking/service.js";
import { defaultTrackingConfig } from "../tracking/config.js";
import { readPullRequestDetails } from "../github/reviews.js";
import type { Store, InputScope } from "../coordinator/store.js";
import type { WorkScheduler } from "../scheduling/work.js";
import type { ApplicationOptions } from "./options.js";
import type { ApplicationInputs } from "./inputs.js";

export interface Closeable {
  close(): Promise<void>;
}

export function createServices(
  directory: string,
  store: Store,
  options: ApplicationOptions,
  inputs: ApplicationInputs,
  register: <T extends Closeable>(service: T) => T,
) {
  const now = options.now ?? Date.now;
  const trackingConfig = options.trackingConfig ?? defaultTrackingConfig();
  const scopedDigestInputs =
    options.digestOptions?.presentation === undefined && options.digestOptions?.ownerFeedbackCovered === undefined;
  const queue = managedQueuePolicy(store.tracking, store.digests, trackingConfig);
  const githubScheduler = register(
    new GitHubScheduler(
      store.schedules,
      {
        tickMs: trackingConfig.polling?.tickMs ?? defaultSchedulerPolicy.tickMs,
        requestSpacingMs: trackingConfig.polling?.requestSpacingMs ?? defaultSchedulerPolicy.requestSpacingMs,
      },
      now,
      options.reviewReader ?? readPullRequestDetails,
      () => {},
    ),
  );
  const tracking = register(
    new TrackingService(store.tracking, trackingConfig, now, {
      ...options.trackingOptions,
      repositoryEnrollment: (prId, agentId, cwd) => {
        store.repositories.bind(prId, agentId, cwd);
      },
      schedules: store.schedules,
      interactive: (work) => githubScheduler.interactive(work),
      stateDirectory: directory,
      managedQueue: queue.managed,
      managedQueueBatch: queue.managedBatch,
      notificationRecorded: (agentId) => {
        inputs.recipient(agentId);
      },
    }),
  );
  const assessments = register(new AssessmentService(store.assessments, tracking, options.model, options.assess, now));
  const issues = register(
    new IssueService(
      store.issues,
      options.issueOptions ?? {
        trackers: [new GitHubIssueTracker()],
        dispatchers: [new CodexDispatcher()],
        workspace: new ManagedIssueWorkspace(),
        codeHost: trackedCodeHost(tracking, directory),
        policy: loadIssuePolicy,
      },
      now,
    ),
  );
  const merging = register(
    new MergeService(store.merging, tracking, trackingConfig.merging ?? {}, directory, store.mergeConflicts, now, {
      referenceInputRevision: inputs.referenceRevision,
      ...options.mergeOptions,
      issueGate: (url) => issues.mergeAllowed(url),
      repositoryInstructions: (message) => store.repositories.forMessage(message),
    }),
  );
  const repairs = register(
    new RepairService(
      store.repairs,
      tracking,
      trackingConfig.repairs,
      directory,
      now,
      options.repairOptions,
      store.conflicts,
    ),
  );
  const submissions = register(
    new SubmissionService(store.submissions, tracking, {
      ...(!trackingConfig.submissionModels ? {} : { models: trackingConfig.submissionModels }),
      ...options.submissionOptions,
    }),
  );
  const digests = register(
    new DigestService(store.digests, tracking, store.submissions, directory, now, {
      ...(scopedDigestInputs ? { inputRevision: inputs.broadRevision } : {}),
      presentation: merging.receipts.presentation,
      ownerFeedbackCovered: (message) => store.merging.ownerFeedbackCovered(message),
      ...options.digestOptions,
    }),
  );
  const submissionNotifications = register(
    new SubmissionNotifications(store.submissions, tracking, options.trackingOptions?.connect, digests.managed),
  );
  const notifications = register(
    new NotificationService(store.notifications, tracking, now, options.notificationReader),
  );
  const startup = [
    assessments,
    repairs,
    submissions,
    submissionNotifications,
    digests,
    tracking,
    merging,
    issues,
    notifications,
    githubScheduler,
  ];
  const shutdown = [
    assessments,
    githubScheduler,
    issues,
    merging,
    digests,
    submissions,
    submissionNotifications,
    repairs,
    notifications,
    tracking,
  ];
  let closing: Promise<void> | undefined;
  return {
    tracking,
    assessments,
    githubScheduler,
    merging,
    issues,
    repairs,
    submissions,
    digests,
    submissionNotifications,
    notifications,
    start(scheduler: WorkScheduler) {
      for (const service of startup) service.start(scheduler);
    },
    close() {
      return (closing ??= Promise.all(shutdown.map((service) => service.close())).then(() => {}));
    },
    stopIntake() {
      notifications.stop();
    },
    checkpointable() {
      return [
        tracking,
        assessments,
        issues,
        merging,
        repairs,
        submissions,
        digests,
        notifications,
        submissionNotifications,
      ].every((service) => service.checkpointable());
    },
    changed(scope?: InputScope) {
      // Unknown scoped changes retain conservative intake invalidation; known observations do not.
      if (scope && (scope.source === undefined || scope.notificationEligibility === true)) notifications.wake();
      digests.wake(scopedDigestInputs && scope?.recipients !== "all" ? scope?.prId : undefined);
      if (!scope) {
        assessments.wake();
        repairs.wake();
        tracking.inputsChanged();
        submissions.wake();
        submissionNotifications.wake();
        issues.wake();
        notifications.wake();
      } else if (scope.source === undefined || scope.source === "tracking") {
        // PR evidence drives these consumers; repair verification and external intake own their deadlines.
        assessments.wake();
        tracking.inputsChanged(scope.prId);
        if (scope.prId === undefined) issues.wake();
        else issues.wakeForPullRequest(store.tracking.prContext(scope.prId).url);
      } else if (scope.source === "issues") {
        issues.wake();
        tracking.wake();
      } else if (scope.source === "submissions") {
        submissions.wake();
        submissionNotifications.wake();
        tracking.wake();
      }
      merging.wake();
      githubScheduler.emit("tick");
    },
    recipient(agentId: string) {
      if (scopedDigestInputs) digests.wakeRecipient(agentId);
      else digests.wake();
      githubScheduler.emit("tick");
    },
  };
}

export type ApplicationServices = ReturnType<typeof createServices>;
