import { createHash } from "node:crypto";
import type { ObservationInput } from "./types.js";
export interface PollPolicy {
  minimumMs: number;
  maximumMs: number;
  activeMaximumMs: number;
}
export const defaultPollPolicy: PollPolicy = {
  minimumMs: 60000,
  maximumMs: 900000,
  activeMaximumMs: 120000,
};
export interface PollState {
  epoch: number;
  active: boolean;
  signature?: string;
  intervalMs: number;
  nextAt: number;
}
function signature(observation: ObservationInput): string {
  const value = { ...observation, observedAt: 0 };
  const normalized = {
    ...value,
    checks: part(observation.checks),
    reviews: part(observation.reviews),
    feedback:
      observation.feedback === undefined
        ? undefined
        : part(observation.feedback),
    workflows:
      observation.workflows === undefined
        ? undefined
        : part(observation.workflows),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
function part(
  value:
    | ObservationInput["checks"]
    | ObservationInput["reviews"]
    | NonNullable<ObservationInput["feedback"]>,
): unknown {
  return value.state === "unavailable"
    ? value
    : {
        ...value,
        value: [...value.value].sort((a, b) => a.id.localeCompare(b.id)),
      };
}
function pending(observation: ObservationInput): boolean {
  return [observation.checks, observation.workflows].some(
    (value) =>
      value === undefined ||
      value.state !== "complete" ||
      value.value.some(
        (check) =>
          !["completed", "success", "failure", "error"].includes(check.status),
      ),
  );
}
export function schedulePoll(
  previous: PollState | undefined,
  epoch: number,
  observation: ObservationInput | undefined,
  at: number,
  policy: PollPolicy,
  trigger: "poll" | "manual",
  retryAt: number,
): PollState {
  const prior = previous?.epoch === epoch ? previous : undefined;
  const nextSignature =
    observation === undefined ? prior?.signature : signature(observation);
  const unchanged =
    prior !== undefined &&
    nextSignature !== undefined &&
    prior.signature === nextSignature;
  const doubled =
    prior === undefined
      ? policy.minimumMs
      : Math.min(policy.maximumMs, prior.intervalMs * 2);
  let intervalMs =
    trigger === "manual"
      ? policy.minimumMs
      : observation === undefined
        ? doubled
        : unchanged
          ? doubled
          : policy.minimumMs;
  const active =
    observation === undefined ? (prior?.active ?? false) : pending(observation);
  if (active) intervalMs = Math.min(intervalMs, policy.activeMaximumMs);
  return {
    epoch,
    active,
    ...(nextSignature === undefined ? {} : { signature: nextSignature }),
    intervalMs,
    nextAt: Math.max(at + intervalMs, retryAt),
  };
}
