import { Type } from "typebox";
import { Check } from "typebox/value";
const timestamp = Type.Union([Type.String(), Type.Null()]);
const job = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  run_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  steps: Type.Array(
    Type.Object({
      conclusion: Type.Union([Type.String(), Type.Null()]),
      started_at: timestamp,
      completed_at: timestamp,
    }),
  ),
});
export function failedStepLogs(
  log: string,
  metadata: unknown,
  expected: { job: string; run: string },
): string {
  if (!Check(job, metadata)) throw new Error("Invalid GitHub job metadata");
  if (
    String(metadata.id) !== expected.job ||
    String(metadata.run_id) !== expected.run
  )
    throw new Error("Job metadata does not match the failed-run evidence");
  const windows = metadata.steps.flatMap((step, index) => {
    if (step.conclusion !== "failure" && step.conclusion !== "timed_out")
      return [];
    const start = Date.parse(step.started_at ?? ""),
      end = Date.parse(step.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error("Failed step timing unavailable");
    // rationale: GitHub rounds step times to seconds; never attribute an adjacent step to this failure.
    const next = metadata.steps
      .slice(index + 1)
      .map((candidate) => Date.parse(candidate.started_at ?? ""))
      .find(Number.isFinite);
    if (next !== undefined && next < start)
      throw new Error("Job step timings are out of order");
    return [{ start, end: Math.min(end + 1000, next ?? Infinity) }];
  });
  if (windows.length === 0) throw new Error("Failed step evidence unavailable");
  return log
    .split("\n")
    .filter((line) => {
      const stamp = /^\uFEFF?(\d{4}-\d\d-\d\dT\S+)/u.exec(line)?.[1];
      const at = Date.parse(stamp ?? "");
      return windows.some((window) => at >= window.start && at < window.end);
    })
    .join("\n");
}
