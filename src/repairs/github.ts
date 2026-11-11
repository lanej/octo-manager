import { ghRead, canonicalPR } from "../tracking/github.js";
import { record, single, type RebaseSource } from "./types.js";
export async function rebaseSource(
  url: string,
  signal: AbortSignal,
): Promise<RebaseSource> {
  const parts = new URL(canonicalPR(url)).pathname.split("/");
  if (
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[4] === undefined
  )
    throw new Error("Invalid repair PR URL");
  const repository = `${parts[1]}/${parts[2]}`;
  const pr = record(
    await ghRead(`repos/${repository}/pulls/${parts[4]}`, signal),
  );
  const head = record(pr["head"]),
    base = record(pr["base"]);
  const sourceRepo = record(head["repo"]);
  if (pr["state"] !== "open" || pr["merged"] === true)
    throw new Error("PR is no longer open");
  if (
    single(sourceRepo["full_name"], "source repository").toLowerCase() !==
    repository
  )
    throw new Error("Fork rebases are not supported in this increment");
  const targetRef = single(base["ref"], "target branch");
  const target = record(
    await ghRead(
      `repos/${repository}/git/ref/heads/${encodeURIComponent(targetRef)}`,
      signal,
    ),
  );
  const result = {
    repository,
    headRef: single(head["ref"], "source branch"),
    headSha: single(head["sha"], "head revision"),
    targetRef,
    targetSha: single(record(target["object"])["sha"], "target revision"),
  };
  if (result.headRef === result.targetRef)
    throw new Error("Source and target branches must differ");
  if (
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(result.headSha) ||
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(result.targetSha)
  )
    throw new Error("Invalid repair Git revision");
  return result;
}
