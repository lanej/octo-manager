export function parseGitHubPR(url: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url);
  const [, owner, repository, pull] = match ?? [];
  if (
    owner === undefined ||
    repository === undefined ||
    pull === undefined ||
    [".", ".."].includes(owner) ||
    [".", ".."].includes(repository)
  )
    throw new Error("Invalid GitHub PR URL");
  return { owner, repository, pull };
}

export function canonicalPR(url: string): string {
  const { owner, repository, pull } = parseGitHubPR(url);
  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}/pull/${pull}`;
}
