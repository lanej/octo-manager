import { cleanText } from "../text.js";
import { parseGitHubPR } from "./pr-identity.js";
import { ghRead, type ReadGitHub } from "./reads.js";
import { githubRecord, requirePublicPullRequest } from "./visibility.js";

export interface ReviewMessage {
  id: string;
  url: string;
  author: string;
  kind: string;
  state: string;
  bodyMarkdown: string;
  atMs: number;
  path: string;
  line?: number | undefined;
  commitSha: string;
  bodyTruncated: boolean;
}

export interface PullRequestDetails {
  url: string;
  title: string;
  state: string;
  headSha: string;
  observedAtMs: number;
  messages: ReviewMessage[];
  mayHaveMoreMessages: boolean;
}

function providerText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export async function readPullRequestDetails(
  url: string,
  signal?: AbortSignal,
  read: ReadGitHub = ghRead,
): Promise<PullRequestDetails> {
  const { owner, repository, pull } = parseGitHubPR(url);
  const prUrl = url.replace(/\/$/, "");
  const root = `repos/${owner}/${repository}`;
  const pullPath = `${root}/pulls/${pull}`;
  const pr = githubRecord(await read(pullPath, signal));
  requirePublicPullRequest(pr);
  const observedAtMs = Date.now();
  // WHY: Confirm public visibility before fetching any review or discussion content.
  const sources = [
    { kind: "review", path: `${pullPath}/reviews?per_page=100` },
    { kind: "review_comment", path: `${pullPath}/comments?per_page=100` },
    {
      kind: "discussion",
      path: `${root}/issues/${pull}/comments?per_page=100`,
    },
  ];
  const collections = await Promise.all(
    sources.map(async ({ kind, path }) => {
      const items = await read(path, signal);
      if (!Array.isArray(items)) throw new Error("GitHub returned an invalid message list");
      const records: unknown[] = items;
      return { kind, items: records };
    }),
  );
  const messages = collections
    .flatMap(({ kind, items }) =>
      items.map((value): ReviewMessage => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("GitHub returned an invalid review or comment");
        const item = githubRecord(value);
        const body = providerText(item["body"]);
        const time = Date.parse(providerText(item["submitted_at"] ?? item["created_at"]));
        const line = item["line"];
        return {
          id: `${kind}:${providerText(item["id"], "undefined")}`,
          url: cleanText(providerText(item["html_url"], prUrl), 2000),
          author: cleanText(providerText(githubRecord(item["user"])["login"], "unknown"), 200),
          kind,
          state: cleanText(providerText(item["state"]), 100),
          bodyMarkdown: cleanText(body, 4000),
          atMs: Number.isFinite(time) ? time : 0,
          path: cleanText(providerText(item["path"]), 1000),
          line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : undefined,
          commitSha: cleanText(providerText(item["commit_id"]), 100),
          bodyTruncated: body.length > 4000,
        };
      }),
    )
    .sort((a, b) => (a.atMs === b.atMs ? a.id.localeCompare(b.id) : a.atMs - b.atMs));
  return {
    url: prUrl,
    title: cleanText(providerText(pr["title"]), 2000),
    state: pr["merged"] === true ? "merged" : cleanText(providerText(pr["state"], "unknown"), 100),
    headSha: cleanText(providerText(githubRecord(pr["head"])["sha"]), 100),
    observedAtMs,
    messages,
    mayHaveMoreMessages: collections.some(({ items }) => items.length >= 100),
  };
}
