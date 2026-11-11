import { trackingPR } from "./evidence.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ObservationInput, ObservationPart } from "./types.js";
const exec = promisify(execFile);
export type ReadGitHub = (path: string, signal?: AbortSignal) => Promise<any>;
export async function ghRead(path: string, signal?: AbortSignal): Promise<any> {
  try {
    const { stdout } = await exec(
      "gh",
      ["api", "--hostname", "github.com", "--method", "GET", path],
      { signal, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      signal?.aborted
        ? "GitHub tracking read cancelled"
        : "GitHub tracking unavailable; check gh authentication, access, and connectivity",
    );
  }
}
export function canonicalPR(url: string): string {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      url,
    );
  if (!m || [".", ".."].includes(m[1]!) || [".", ".."].includes(m[2]!))
    throw new Error("Invalid GitHub PR URL");
  return `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/pull/${m[3]}`;
}
async function collection<T>(
  path: string,
  field: string | undefined,
  map: (x: any) => T,
  read: ReadGitHub,
  signal?: AbortSignal,
): Promise<ObservationPart<T[]>> {
  const items: T[] = [];
  try {
    // WHY: Bounded pagination exposes incomplete evidence instead of clearing blockers from a truncated read.
    for (let page = 1; page <= 10; page++) {
      const raw = await read(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
      );
      const values = field ? raw[field] : raw;
      if (!Array.isArray(values)) throw new Error("Invalid GitHub collection");
      items.push(...values.map(map));
      if (values.length < 100) return { state: "complete", value: items };
    }
    return {
      state: "partial",
      value: items,
      reason: "First 1000 records; more may exist",
    };
  } catch {
    return items.length
      ? {
          state: "partial",
          value: items,
          reason: "A later page could not be read",
        }
      : { state: "unavailable", reason: "GitHub collection unavailable" };
  }
}
export async function readObservation(
  url: string,
  signal?: AbortSignal,
  read: ReadGitHub = ghRead,
  now = Date.now,
): Promise<ObservationInput> {
  const [, owner, repo, , number] = new URL(canonicalPR(url)).pathname.split(
    "/",
  );
  if (owner === undefined || repo === undefined || number === undefined)
    throw new Error("Invalid GitHub PR URL");
  const root = `repos/${owner}/${repo}`;
  const pr = trackingPR(await read(`${root}/pulls/${number}`, signal));
  // rationale: The PR payload can retain an ancestor base SHA after the target branch advances.
  const refPath = `${root}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`;
  const readTarget = async () => {
    const raw: unknown = await read(refPath, signal);
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("object" in raw) ||
      typeof raw.object !== "object" ||
      raw.object === null ||
      !("sha" in raw.object) ||
      typeof raw.object.sha !== "string" ||
      raw.object.sha === ""
    )
      throw new Error("Invalid GitHub target branch observation");
    return { ref: pr.base.ref, sha: raw.object.sha };
  };
  const target =
    pr.state === "open" && !pr.merged ? await readTarget() : undefined;
  const observedAt = now();
  const [runs, statuses, reviews] = await Promise.all([
    collection(
      `${root}/commits/${pr.head.sha}/check-runs?filter=latest`,
      "check_runs",
      (c: any) => ({
        id: `run:${c.id}`,
        key: `run:${c.app?.id ?? ""}:${c.name}`,
        name: String(c.name),
        headSha: String(c.head_sha),
        status: String(c.status),
        conclusion: String(c.conclusion ?? ""),
        at: Date.parse(c.started_at ?? c.completed_at ?? "") || 0,
        url: String(c.html_url ?? url),
      }),
      read,
      signal,
    ),
    collection(
      `${root}/commits/${pr.head.sha}/statuses`,
      undefined,
      (c: any) => ({
        id: `status:${c.id}`,
        key: `status:${c.context}`,
        name: String(c.context),
        headSha: pr.head.sha,
        status: String(c.state),
        conclusion: String(c.state),
        at: Date.parse(c.created_at ?? "") || 0,
        url: String(c.target_url ?? url),
      }),
      read,
      signal,
    ),
    collection(
      `${root}/pulls/${number}/reviews`,
      undefined,
      (r: any) => ({
        id: String(r.id),
        author: String(r.user?.login ?? "unknown"),
        headSha: String(r.commit_id ?? ""),
        state: String(r.state),
        at: Date.parse(r.submitted_at ?? "") || 0,
        url: String(r.html_url ?? url),
      }),
      read,
      signal,
    ),
  ]);
  const checks: ObservationInput["checks"] =
    runs.state === "complete" && statuses.state === "complete"
      ? { state: "complete", value: [...runs.value, ...statuses.value] }
      : runs.state === "unavailable" && statuses.state === "unavailable"
        ? { state: "unavailable", reason: "Checks unavailable" }
        : {
            state: "partial",
            value: [
              ...(runs.state === "unavailable" ? [] : runs.value),
              ...(statuses.state === "unavailable" ? [] : statuses.value),
            ],
            reason: "Some check sources are incomplete",
          };
  const [latestPR, latestTarget] = await Promise.all([
    read(`${root}/pulls/${number}`, signal).then(trackingPR),
    target === undefined ? undefined : readTarget(),
  ]);
  if (
    latestPR.head.sha !== pr.head.sha ||
    latestPR.base.ref !== pr.base.ref ||
    latestTarget?.sha !== target?.sha ||
    latestPR.state !== pr.state ||
    latestPR.merged !== pr.merged ||
    latestPR.mergeable !== pr.mergeable
  )
    throw new Error(
      "GitHub PR revisions changed during observation; refresh again",
    );
  return {
    observedAt,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    ...(target === undefined ? {} : { targetBase: target }),
    lifecycle: pr.merged ? "merged" : pr.state,
    mergeability:
      pr.mergeable === true
        ? "mergeable"
        : pr.mergeable === false
          ? "conflicting"
          : "unknown",
    checks,
    reviews,
  };
}
