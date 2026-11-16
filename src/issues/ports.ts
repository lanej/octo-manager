import type {
  Assignment,
  IssueReference,
  IssueRecord,
  StageResult,
  TrackerObservation,
} from "./contracts.js";
// Write adapters must invoke authorize immediately before dispatch, after any awaited preparation.
export interface IssueTracker {
  provider: string;
  identify(url: string): IssueReference;
  verifyRepository(root: string, ref: IssueReference): void;
  observe(
    ref: IssueReference,
    signal: AbortSignal,
  ): Promise<TrackerObservation>;
  post(
    ref: IssueReference,
    key: string,
    body: string,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string>;
  findPost(
    ref: IssueReference,
    key: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  createFollowUp(
    ref: IssueReference,
    key: string,
    title: string,
    body: string,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string>;
  findFollowUp(
    ref: IssueReference,
    key: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  close(
    ref: IssueReference,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<void>;
}
export interface DispatchStatus {
  state: "running" | "completed" | "failed" | "uncertain";
  sessionId: string;
  turnId: string;
  result?: StageResult;
  detail: string;
}
export interface AgentDispatcher {
  harness: string;
  submit(
    assignment: Assignment,
    checkpoint: (sessionId: string) => void,
    signal: AbortSignal,
  ): Promise<DispatchStatus>;
  inspect(assignment: Assignment, signal: AbortSignal): Promise<DispatchStatus>;
  // True confirms terminal execution; interrupt acceptance alone returns false.
  cancel(assignment: Assignment, signal: AbortSignal): Promise<boolean>;
}
export interface IssueWorkspace {
  allocate(root: string, ownerId: string, issueId: string): Promise<string>;
}
export interface CodeHostStatus {
  merged: boolean;
  closed: boolean;
  head: string;
  checks: "pending" | "passed" | "failed";
  feedback: string[];
}
export interface IssueCodeHost {
  commit(
    issue: IssueRecord,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string>;
  publish(
    key: string,
    issue: IssueRecord,
    value: StageResult,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<{ url: string; head: string }>;
  enroll(url: string, ownerId: string, root: string): void;
  inspect(url: string): CodeHostStatus | undefined;
}
