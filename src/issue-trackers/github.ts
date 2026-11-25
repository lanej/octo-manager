import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { githubReads } from "../github/reads.js";
import { checked } from "../merging/contracts.js";
import type { IssueTracker } from "../issues/ports.js";
import type { IssueReference, IssueComment } from "../issues/contracts.js";
const item = Type.Object({
  id: Type.Number(),
  body: Type.Union([Type.String(), Type.Null()]),
  html_url: Type.String(),
  updated_at: Type.String(),
  user: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]),
});
const issueSchema = Type.Object({
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  state: Type.String(),
  updated_at: Type.String(),
  pull_request: Type.Optional(Type.Object({ url: Type.String() })),
});
function base(ref: IssueReference): string {
  if (
    ref.provider !== "github" ||
    !/^[\w.-]+\/[\w.-]+$/u.test(ref.project) ||
    !/^[1-9]\d*$/u.test(ref.externalId)
  )
    throw new Error("Invalid GitHub issue identity");
  return `repos/${ref.project}/issues`;
}
const marker = (key: string) => `<!-- octo-issue:${key} -->`;
export class GitHubIssueTracker implements IssueTracker {
  readonly provider = "github";
  constructor(
    private reads: Pick<
      typeof githubReads,
      "read" | "post" | "patch"
    > = githubReads,
  ) {}
  identify(url: string): IssueReference {
    const match =
      /^https:\/\/github.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/u.exec(
        url,
      );
    if (match?.[1] == null || match[2] == null)
      throw new Error("Expected a github.com issue URL");
    return {
      provider: this.provider,
      project: match[1],
      externalId: match[2],
      url: url.replace(/\/$/u, ""),
    };
  }
  verifyRepository(root: string, ref: IssueReference): void {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const expected = ref.project.toLowerCase();
    const project = remote
      .replace(
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/u,
        "",
      )
      .replace(/\.git$/u, "")
      .toLowerCase();
    if (project !== expected)
      throw new Error(
        "Issue does not belong to the selected repository checkout",
      );
  }
  async observe(ref: IssueReference, signal: AbortSignal) {
    const value = checked(
      issueSchema,
      await this.reads.read(`${base(ref)}/${ref.externalId}`, signal),
    );
    if (value.pull_request != null)
      throw new Error("Use PR tracking for pull requests");
    const comments: IssueComment[] = [];
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const values = checked(
        Type.Array(item),
        await this.reads.read(
          `${base(ref)}/${ref.externalId}/comments?per_page=100&page=${String(page)}`,
          signal,
        ),
      );
      for (const comment of values)
        comments.push({
          id: String(comment.id),
          revision: comment.updated_at,
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
          url: comment.html_url,
        });
      if (values.length < 100) {
        complete = comments.every((comment) => comment.body.length <= 16000);
        break;
      }
    }
    return {
      title: value.title,
      body: value.body ?? "",
      closed: value.state !== "open",
      comments,
      complete,
      revision: value.updated_at,
    };
  }
  async findPost(ref: IssueReference, key: string, signal: AbortSignal) {
    const observation = await this.observe(ref, signal);
    if (!observation.complete)
      throw new Error(
        "Incomplete comment evidence prevents write reconciliation",
      );
    return observation.comments.find((comment) =>
      comment.body.includes(marker(key)),
    )?.url;
  }
  async post(
    ref: IssueReference,
    key: string,
    body: string,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<string> {
    const response = checked(
      Type.Object({ html_url: Type.String() }),
      await this.reads.post(
        `${base(ref)}/${ref.externalId}/comments`,
        { body: `${body}\n\n${marker(key)}` },
        signal,
        authorize,
      ),
    );
    return response.html_url;
  }
  async findFollowUp(ref: IssueReference, key: string, signal: AbortSignal) {
    for (let page = 1; page <= 10; page++) {
      const values = checked(
        Type.Array(
          Type.Object({
            html_url: Type.String(),
            body: Type.Union([Type.String(), Type.Null()]),
          }),
        ),
        await this.reads.read(
          `${base(ref)}?state=all&per_page=100&page=${String(page)}`,
          signal,
        ),
      );
      const found = values.find(
        (value) => value.body?.includes(marker(key)) ?? false,
      );
      if (found != null) return found.html_url;
      if (values.length < 100) return undefined;
    }
    throw new Error(
      "Incomplete issue inventory prevents follow-up reconciliation",
    );
  }
  async createFollowUp(
    ref: IssueReference,
    key: string,
    title: string,
    body: string,
    signal: AbortSignal,
    authorize: () => void,
  ) {
    const response = checked(
      Type.Object({ html_url: Type.String() }),
      await this.reads.post(
        base(ref),
        { title, body: `${body}\n\nFollow-up to ${ref.url}\n\n${marker(key)}` },
        signal,
        authorize,
      ),
    );
    return response.html_url;
  }
  async close(
    ref: IssueReference,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<void> {
    await this.reads.patch(
      `${base(ref)}/${ref.externalId}`,
      { state: "closed", state_reason: "completed" },
      signal,
      authorize,
    );
  }
}
