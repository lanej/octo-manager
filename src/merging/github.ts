import { mergeProgress, type MergeProgress } from "./async-merge.js";
import { Type, type Static } from "typebox";
import { githubReads } from "../github-api.js";
import { canonicalPR, readObservation } from "../tracking/github.js";
import type { ObservationInput } from "../tracking/types.js";
import { checked, Sha, type MergeEntry } from "./contracts.js";
const GateSchema = Type.Object({
  stack: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({
        baseRefName: Type.String(),
        entries: Type.Object({
          nodes: Type.Array(
            Type.Object({
              pullRequest: Type.Object({
                url: Type.String(),
                state: Type.String(),
              }),
            }),
          ),
          pageInfo: Type.Object({ hasNextPage: Type.Boolean() }),
        }),
      }),
    ]),
  ),
  headRefOid: Sha,
  baseRefName: Type.String(),
  baseRefOid: Sha,
  merged: Type.Boolean(),
  state: Type.String(),
  isDraft: Type.Boolean(),
  mergeable: Type.String(),
  mergeStateStatus: Type.String(),
  reviewDecision: Type.Union([Type.String(), Type.Null()]),
  mergeCommit: Type.Union([Type.Object({ oid: Sha }), Type.Null()]),
  baseRef: Type.Union([
    Type.Object({
      target: Type.Object({ oid: Sha }),
      branchProtectionRule: Type.Union([
        Type.Object({ requiredStatusCheckContexts: Type.Array(Type.String()) }),
        Type.Null(),
      ]),
    }),
    Type.Null(),
  ]),
});
const RepoSchema = Type.Object({
  squashMergeAllowed: Type.Boolean(),
  mergeCommitAllowed: Type.Boolean(),
  rebaseMergeAllowed: Type.Boolean(),
  pullRequest: GateSchema,
});
const RulesSchema = Type.Array(
  Type.Object({
    type: Type.String(),
    parameters: Type.Optional(
      Type.Object({
        required_status_checks: Type.Optional(
          Type.Array(Type.Object({ context: Type.String() })),
        ),
      }),
    ),
  }),
);
export interface MergeSnapshot {
  observation: ObservationInput;
  draft: boolean;
  gate: string;
  review: string | null;
  required: string[];
  queueRequired: boolean;
  methods: MergeEntry["method"][];
  mergeCommit?: string;
  nativePrerequisites?: string[];
}
export interface MergeProvider {
  inspect(url: string, signal: AbortSignal): Promise<MergeSnapshot>;
  merge(
    url: string,
    head: string,
    method: MergeEntry["method"],
    signal: AbortSignal,
    beforeSend: () => void,
  ): Promise<string | MergeProgress>;
  result?(
    url: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<MergeProgress>;
}
function location(url: string) {
  const [, owner, repo, , number] = new URL(canonicalPR(url)).pathname.split(
    "/",
  );
  if (owner === undefined || repo === undefined || number === undefined)
    throw new Error("Invalid PR location");
  return { owner, repo, number, root: `repos/${owner}/${repo}` };
}
export const mergeProvider: MergeProvider = {
  async inspect(url, signal) {
    const { owner, repo, number, root } = location(url);
    const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed pullRequest(number:${number}) { stack { baseRefName entries(first:50) { nodes { pullRequest { url state } } pageInfo { hasNextPage } } } headRefOid baseRefName baseRefOid merged state isDraft mergeable mergeStateStatus reviewDecision mergeCommit { oid } baseRef { target { oid } branchProtectionRule { requiredStatusCheckContexts } } } } }`;
    const observation = await readObservation(url, signal);
    const result = await githubReads.query(query, signal);
    if (result.errors.length > 0)
      throw new Error("Merge eligibility unavailable");
    const repository = checked(RepoSchema, result.data["repository"]),
      pr = repository.pullRequest;
    if (
      pr.headRefOid !== observation.headSha ||
      (pr.baseRefName !== observation.targetBase?.ref &&
        observation.lifecycle === "open") ||
      (pr.baseRef?.target.oid !== observation.targetBase?.sha &&
        observation.lifecycle === "open")
    )
      throw new Error("PR changed during eligibility inspection");
    const rules =
      pr.state === "OPEN"
        ? checked(
            RulesSchema,
            await githubReads.read(
              `${root}/rules/branches/${encodeURIComponent(pr.baseRefName)}`,
              signal,
            ),
          )
        : [];
    const nativePrerequisites: string[] = [];
    if (pr.stack !== undefined && pr.stack !== null) {
      if (pr.stack.entries.pageInfo.hasNextPage)
        throw new Error(
          "Native stack exceeds bounded inspection; owner intervention required",
        );
      let found = false;
      for (const entry of pr.stack.entries.nodes) {
        if (entry.pullRequest.url === canonicalPR(url)) {
          found = true;
          break;
        }
        if (entry.pullRequest.state === "OPEN")
          nativePrerequisites.push(entry.pullRequest.url);
      }
      if (!found)
        throw new Error("Current PR missing from native stack evidence");
      if (
        nativePrerequisites.length === 0 &&
        pr.baseRefName !== pr.stack.baseRefName
      )
        throw new Error("Native stack target branch has not settled");
    }
    const methods: MergeEntry["method"][] = [];
    if (repository.squashMergeAllowed) methods.push("squash");
    if (repository.mergeCommitAllowed) methods.push("merge");
    if (repository.rebaseMergeAllowed) methods.push("rebase");
    return {
      observation,
      nativePrerequisites,
      draft: pr.isDraft,
      gate: pr.mergeStateStatus,
      review: pr.reviewDecision,
      required: [
        ...new Set([
          ...(pr.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ??
            []),
          ...rules.flatMap((rule) =>
            rule.type === "required_status_checks"
              ? (rule.parameters?.required_status_checks?.map(
                  (check) => check.context,
                ) ?? [])
              : [],
          ),
        ]),
      ],
      queueRequired: rules.some((rule) => rule.type === "merge_queue"),
      methods,
      ...(pr.merged && pr.mergeCommit !== null
        ? { mergeCommit: pr.mergeCommit.oid }
        : {}),
    };
  },
  async merge(url, head, method, signal, beforeSend) {
    const { root, number } = location(url);
    return mergeProgress(
      await githubReads.write(
        `${root}/pulls/${number}/merge-async`,
        {
          sha: head,
          merge_method: method,
          merge_action: "direct_merge",
          bypass_rules: false,
        },
        signal,
        beforeSend,
      ),
    );
  },
  async result(url, requestId, signal) {
    const { root, number } = location(url);
    return mergeProgress(
      await githubReads.read(
        `${root}/pulls/${number}/merge-async/${encodeURIComponent(requestId)}`,
        signal,
      ),
      requestId,
    );
  },
};
export type GitHubGate = Static<typeof GateSchema>;
