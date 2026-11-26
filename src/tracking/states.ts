export enum PRLifecycle {
  Open = "open",
  Closed = "closed",
  Merged = "merged",
}
export type PRLifecycleValue = `${PRLifecycle}`;
export enum ReviewState {
  Pending = "PENDING",
  Commented = "COMMENTED",
  Approved = "APPROVED",
  ChangesRequested = "CHANGES_REQUESTED",
  Dismissed = "DISMISSED",
}
export type ReviewStateValue = `${ReviewState}`;

export function prLifecycle(value: unknown): PRLifecycle {
  const state = Object.values(PRLifecycle).find((candidate) => candidate === value);
  if (state === undefined) throw new Error("Invalid PR lifecycle");
  return state;
}

export function reviewState(value: unknown): ReviewState {
  const state = Object.values(ReviewState).find((candidate) => candidate === value);
  if (state === undefined) throw new Error("Invalid review state");
  return state;
}

export function terminalPR(value: PRLifecycleValue): boolean {
  const state = prLifecycle(value);
  switch (state) {
    case PRLifecycle.Open:
      return false;
    case PRLifecycle.Closed:
    case PRLifecycle.Merged:
      return true;
    default:
      return unreachable(state);
  }
}

export function pendingReview(value: ReviewStateValue): boolean {
  const state = reviewState(value);
  switch (state) {
    case ReviewState.Pending:
      return true;
    case ReviewState.Commented:
    case ReviewState.Approved:
    case ReviewState.ChangesRequested:
    case ReviewState.Dismissed:
      return false;
    default:
      return unreachable(state);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled tracking state: ${String(value)}`);
}

export function effectiveReview(value: ReviewStateValue): boolean {
  const state = reviewState(value);
  switch (state) {
    case ReviewState.Approved:
    case ReviewState.ChangesRequested:
    case ReviewState.Dismissed:
      return true;
    case ReviewState.Pending:
    case ReviewState.Commented:
      return false;
    default:
      return unreachable(state);
  }
}
