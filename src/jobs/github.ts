import { requirePublicPullRequest } from "../github/visibility.js";
import { ghRead } from "../github/reads.js";
import { parseTask } from "./domain.js";
import { cleanText } from "../text.js";
export async function readPullRequest(url: string, signal?: AbortSignal): Promise<unknown> {
  const task = parseTask({ kind: "summarize_pr", url });
  if (task.kind !== "summarize_pr") throw new Error("Expected PR task");
  const [, owner, repo, , number] = new URL(task.url).pathname.split("/");
  if (owner === undefined || repo === undefined || number === undefined) throw new Error("Invalid GitHub PR URL");
  const pr: unknown = await ghRead(`repos/${owner}/${repo}/pulls/${number}`, signal);
  if (typeof pr !== "object" || pr === null || Array.isArray(pr)) throw new Error("Invalid GitHub PR response");
  return publicPullRequest(Object.fromEntries(Object.entries(pr)));
}
export function publicPullRequest(pr: Record<string, any>): unknown {
  requirePublicPullRequest(pr);
  return { url: pr.html_url, title: cleanText(String(pr.title), 2000), body: cleanText(String(pr.body ?? ""), 16000), bodyTruncated: String(pr.body ?? "").length > 16000, state: pr.state, merged: pr.merged, headSha: pr.head?.sha, base: pr.base?.ref };
}
