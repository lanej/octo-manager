import type { Assess } from "../assessments/runner.js";
import type { IssueOptions } from "../issues/service.js";
import type { MergeOptions } from "../merging/service.js";
import type { NotificationReader } from "../tracking/notification-reader.js";
import type { DigestOptions } from "../notifications/service.js";
import type { SubmissionOptions } from "../submissions/service.js";
import type { RepairOptions } from "../repairs/service.js";
import type { TrackingConfig } from "../tracking/config.js";
import type { TrackingOptions } from "../tracking/service.js";
import type { readPullRequestDetails } from "../github/reviews.js";
export interface ApplicationOptions {
  assess?: Assess;
  issueOptions?: IssueOptions;
  mergeOptions?: MergeOptions;
  notificationReader?: NotificationReader;
  digestOptions?: DigestOptions;
  submissionOptions?: SubmissionOptions;
  repairOptions?: RepairOptions;
  trackingConfig?: TrackingConfig;
  trackingOptions?: TrackingOptions;
  now?: () => number;
  workerPath?: string;
  model?: string;
  workerEnv?: NodeJS.ProcessEnv;
  reviewReader?: typeof readPullRequestDetails;
}
