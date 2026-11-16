import { Type } from "typebox";
import { Check } from "typebox/value";
import type { GitHubTransport } from "../github-sdk.js";
import type { IssueRecord } from "./contracts.js";

const linkedPR = Type.Object({
  html_url: Type.String(),
  state: Type.String(),
  merged: Type.Boolean(),
  head: Type.Object({
    sha: Type.String(),
    ref: Type.String(),
    repo: Type.Object({ full_name: Type.String() }),
  }),
  base: Type.Object({
    ref: Type.String(),
    repo: Type.Object({ full_name: Type.String() }),
  }),
});

// A remediation updates its linked PR; uncertain pushes reconcile by reading that same PR again.
export async function updateIssuePR(
  issue: Pick<IssueRecord, "prUrl" | "prHead">,
  tested: { repository: string; branch: string; base: string; head: string },
  transport: GitHubTransport,
  push: (branch: string) => Promise<void>,
  signal: AbortSignal,
  authorize: () => void,
): Promise<{ url: string; head: string }> {
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/u.exec(
      issue.prUrl,
    );
  if (match?.[1] !== tested.repository || match[2] === undefined)
    throw new Error("Linked PR does not belong to the verified code host");
  const number = match[2];
  const read = async () => {
    const response = await transport(
      { method: "GET", path: `repos/${tested.repository}/pulls/${number}` },
      signal,
    );
    if (response.status !== 200)
      throw new Error("Linked PR observation unavailable");
    const value: unknown = JSON.parse(response.body);
    if (!Check(linkedPR, value))
      throw new Error("Invalid linked PR observation");
    if (
      value.html_url !== issue.prUrl ||
      value.state !== "open" ||
      value.merged ||
      value.head.repo.full_name !== tested.repository ||
      value.base.repo.full_name !== tested.repository ||
      value.head.ref !== tested.branch ||
      value.base.ref !== tested.base
    )
      throw new Error(
        "Linked PR no longer matches the authorized issue branch",
      );
    return value;
  };
  const before = await read();
  if (before.head.sha !== tested.head) {
    if (before.head.sha !== issue.prHead)
      throw new Error(
        "Linked PR head changed; observe and retest before updating",
      );
    signal.throwIfAborted();
    authorize();
    await push(before.head.ref);
  }
  const confirmed = await read();
  if (confirmed.head.sha !== tested.head)
    throw new Error(
      "Linked PR update unconfirmed; reconcile before continuing",
    );
  return { url: issue.prUrl, head: tested.head };
}
