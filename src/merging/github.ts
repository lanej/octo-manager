import { Type, type Static } from "typebox";
import { githubReads } from "../github-api.js";
import { canonicalPR, readObservation } from "../tracking/github.js";
import type { ObservationInput } from "../tracking/types.js";
import { checked, Sha, type MergeEntry } from "./contracts.js";
const GateSchema = Type.Object({
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
}
export interface MergeProvider {
  inspect(url: string, signal: AbortSignal): Promise<MergeSnapshot>;
  merge(
    url: string,
    head: string,
    method: MergeEntry["method"],
    signal: AbortSignal,
    beforeSend: () => void,
  ): Promise<string>;
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
    const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed pullRequest(number:${number}) { headRefOid baseRefName baseRefOid merged state isDraft mergeable mergeStateStatus reviewDecision mergeCommit { oid } baseRef { target { oid } branchProtectionRule { requiredStatusCheckContexts } } } } }`;
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
    const methods: MergeEntry["method"][] = [];
    if (repository.squashMergeAllowed) methods.push("squash");
    if (repository.mergeCommitAllowed) methods.push("merge");
    if (repository.rebaseMergeAllowed) methods.push("rebase");
    return {
      observation,
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
    const result = checked(
      Type.Object({ merged: Type.Boolean(), sha: Sha }),
      await githubReads.write(
        `${root}/pulls/${number}/merge`,
        { sha: head, merge_method: method },
        signal,
        beforeSend,
      ),
    );
    if (!result.merged) throw new Error("GitHub did not confirm the merge");
    return result.sha;
  },
};
export type GitHubGate = Static<typeof GateSchema>;
