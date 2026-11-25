export class GitHubRequestCancelledError extends Error {
  constructor(message = "GitHub request cancelled") {
    super(message);
    this.name = "GitHubRequestCancelledError";
  }
}

export function throwIfGitHubCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new GitHubRequestCancelledError();
}
