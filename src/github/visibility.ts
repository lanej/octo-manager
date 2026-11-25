export function githubRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(Object.entries(value));
}

export function requirePublicPullRequest(value: unknown): void {
  const base = githubRecord(githubRecord(value)["base"]);
  const repo = githubRecord(base["repo"]);
  if (repo["private"] !== false)
    throw new Error(
      "Only confirmed public repository PRs may be sent to the model",
    );
}
