import { githubReads } from "./github-api.js";
import { cleanText, parseTask } from "./domain.js";
export async function readPullRequest(url: string, signal?: AbortSignal): Promise<unknown> {
  const task = parseTask({ kind: "summarize_pr", url });
  if (task.kind !== "summarize_pr") throw new Error("Expected PR task");
  const [, owner, repo, , number] = new URL(task.url).pathname.split("/");
  if (owner === undefined || repo === undefined || number === undefined) throw new Error("Invalid GitHub PR URL");
  const pr: unknown = await githubRead(`repos/${owner}/${repo}/pulls/${number}`, signal);
  if (typeof pr !== "object" || pr === null || Array.isArray(pr)) throw new Error("Invalid GitHub PR response");
  return publicPullRequest(Object.fromEntries(Object.entries(pr)));
}
export function publicPullRequest(pr: Record<string, any>): unknown {
  if (pr.base?.repo?.private !== false) throw new Error("Only confirmed public repository PRs may be sent to the model");
  return { url: pr.html_url, title: cleanText(String(pr.title), 2000), body: cleanText(String(pr.body ?? ""), 16000), bodyTruncated: String(pr.body ?? "").length > 16000, state: pr.state, merged: pr.merged, headSha: pr.head?.sha, base: pr.base?.ref };
}

export interface ReviewMessage {
  id: string; url: string; author: string; kind: string; state: string; bodyMarkdown: string;
  atMs: number; path: string; line?: number; commitSha: string; bodyTruncated: boolean;
}
export interface PullRequestDetails {
  url: string; title: string; state: string; headSha: string; observedAtMs: number;
  messages: ReviewMessage[]; mayHaveMoreMessages: boolean;
}
export type GithubRead = (path: string, signal?: AbortSignal) => Promise<any>;
async function githubRead(path: string, signal?: AbortSignal): Promise<any> {
  return githubReads.read(path, signal);
}
export async function readPullRequestDetails(url: string, signal?: AbortSignal, read: GithubRead = githubRead): Promise<PullRequestDetails> {
  const task = parseTask({ kind: "summarize_pr", url });
  if (task.kind !== "summarize_pr") throw new Error("Expected PR task");
  const parts = new URL(task.url).pathname.split("/");
  const root = `repos/${parts[1]}/${parts[2]}`;
  const pull = `${root}/pulls/${parts[4]}`;
  const pr = await read(pull, signal);
  publicPullRequest(pr);
  const observedAtMs = Date.now();
  // WHY: Confirm public visibility before fetching any review or discussion content.
  const sources = await Promise.all([
    read(`${pull}/reviews?per_page=100`, signal),
    read(`${pull}/comments?per_page=100`, signal),
    read(`${root}/issues/${parts[4]}/comments?per_page=100`, signal),
  ]);
  if (!sources.every(Array.isArray)) throw new Error("GitHub returned an invalid message list");
  const kinds = ["review", "review_comment", "discussion"];
  const messages: ReviewMessage[] = sources.flatMap((items, index) => items.map((item: any) => {
    const body = String(item.body ?? "");
    const time = Date.parse(String(item.submitted_at ?? item.created_at ?? ""));
    return { id: `${kinds[index]}:${String(item.id)}`, url: cleanText(String(item.html_url ?? task.url), 2000), author: cleanText(String(item.user?.login ?? "unknown"), 200), kind: kinds[index]!, state: cleanText(String(item.state ?? ""), 100), bodyMarkdown: cleanText(body, 4000), atMs: Number.isFinite(time) ? time : 0, path: cleanText(String(item.path ?? ""), 1000), line: Number.isSafeInteger(item.line) && item.line > 0 ? item.line : undefined, commitSha: cleanText(String(item.commit_id ?? ""), 100), bodyTruncated: body.length > 4000 };
  })).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  return { url: task.url, title: cleanText(String(pr.title ?? ""), 2000), state: pr.merged === true ? "merged" : cleanText(String(pr.state ?? "unknown"), 100), headSha: cleanText(String(pr.head?.sha ?? ""), 100), observedAtMs, messages, mayHaveMoreMessages: sources.some(items => items.length >= 100) };
}
