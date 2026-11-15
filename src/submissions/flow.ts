import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { SubmissionInput, RepositorySnapshot } from "./contracts.js";
const exec = promisify(execFile);
const AnalysisSchema = Type.Object({
  schema_version: Type.Literal(4),
  analysis_id: Type.String(),
  provenance: Type.Object({
    base_sha: Type.String(),
    head_sha: Type.String(),
    repository: Type.String(),
    comparison_head_repository: Type.String(),
    comparison_scope: Type.Optional(Type.Literal("changed-files")),
  }),
  graph: Type.Object({
    nodes: Type.Array(Type.Unknown()),
    edges: Type.Array(Type.Unknown()),
    diagnostics: Type.Array(Type.Unknown()),
    coverage: Type.Unknown(),
  }),
});
async function capture(
  request: SubmissionInput,
  snapshot: RepositorySnapshot,
  directory: string,
  signal: AbortSignal,
  changedFilesOnly: boolean,
  binary: string,
): Promise<unknown> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(join(directory, "analysis.json"))) {
      await exec(
        binary,
        [
          "analyze-refs",
          ...(changedFilesOnly ? ["--changed-files-only"] : []),
          "--repository",
          request.repository,
          "--base",
          snapshot.baseSha,
          "--head",
          request.headSha,
          "--head-repository",
          request.headRepository ?? request.repository,
          "--output",
          directory,
        ],
        { signal, timeout: 120000, maxBuffer: 1024 * 1024 },
      );
    }
    const file = join(directory, "analysis.json");
    if ((await stat(file)).size > 32 * 1024 * 1024)
      throw new OversizedCapture(
        "PR Flow analysis exceeds 32 MiB integration bound",
      );
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !Check(AnalysisSchema, data) ||
      data.provenance.base_sha !== snapshot.baseSha ||
      data.provenance.head_sha !== request.headSha ||
      data.provenance.comparison_head_repository.toLowerCase() !==
        (request.headRepository ?? request.repository).toLowerCase() ||
      (data.provenance.comparison_scope === "changed-files") !==
        changedFilesOnly ||
      data.provenance.repository.toLowerCase() !==
        request.repository.toLowerCase()
    )
      throw new Error(
        "PR Flow analysis identity or schema disagrees with preparation",
      );
    const query = async (kind: string, limit: number) => {
      const output = await exec(
        binary,
        ["map", directory, "--kind", kind, "--limit", String(limit)],
        { signal, timeout: 120000, maxBuffer: 1024 * 1024 },
      );
      const value: unknown = JSON.parse(output.stdout);
      const schema = Type.Object({
        analysis_id: Type.Literal(data.analysis_id),
        total: Type.Integer({ minimum: 0 }),
        records: Type.Array(Type.Unknown(), { maxItems: limit }),
      });
      if (!Check(schema, value))
        throw new Error(
          "PR Flow query identity or result disagrees with capture",
        );
      return value;
    };
    // Queries use PR Flow's own digest validation, also when reusing a retained capture.
    const nodes = await query("nodes", 150),
      edges = await query("edges", 150),
      interactions = await query("interactions", 100);
    return {
      available: true,
      scope: changedFilesOnly ? "changed-files" : "repository",
      analysisId: data.analysis_id,
      schemaVersion: data.schema_version,
      coverage: data.graph.coverage,
      nodeCount: data.graph.nodes.length,
      edgeCount: data.graph.edges.length,
      nodes: nodes.records,
      edges: edges.records,
      interactions: interactions.records,
      interactionCount: interactions.total,
      diagnostics: data.graph.diagnostics.slice(0, 50),
      limited:
        changedFilesOnly ||
        data.graph.nodes.length > 150 ||
        data.graph.edges.length > 150 ||
        interactions.total > 100 ||
        data.graph.diagnostics.length > 50,
    };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
class OversizedCapture extends Error {}
function captureFailure(error: unknown): string {
  const details: Record<string, string | number | boolean | null> = {
    message:
      error instanceof Error
        ? error.message
        : "Full capture exceeded supported bounds",
  };
  if (typeof error === "object" && error !== null) {
    for (const key of [
      "stdout",
      "stderr",
      "code",
      "signal",
      "killed",
    ] as const) {
      if (!(key in error)) continue;
      const value: unknown = Reflect.get(error, key);
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        details[key] = value;
    }
  }
  return JSON.stringify(details, null, 2);
}
function oversized(error: unknown): boolean {
  if (error instanceof OversizedCapture) return true;
  if (
    typeof error !== "object" ||
    error === null ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  )
    return false;
  try {
    const value: unknown = JSON.parse(error.stderr);
    return Check(
      Type.Object({
        error: Type.Object({ code: Type.Literal("analysis_too_large") }),
      }),
      value,
    );
  } catch {
    return false;
  }
}
export async function analyzeFlow(
  request: SubmissionInput,
  snapshot: RepositorySnapshot,
  directory: string,
  signal: AbortSignal,
  binary = process.env["OCTO_PR_FLOW"] ?? "pr-flow",
): Promise<unknown> {
  try {
    const scoped = join(directory, "changed-files"),
      failure = join(directory, "full-capture-failure.txt");
    if (existsSync(join(scoped, "analysis.json"))) {
      const result = await capture(
        request,
        snapshot,
        scoped,
        signal,
        true,
        binary,
      );
      if (typeof result !== "object" || result === null)
        throw new Error("Invalid retained analysis result");
      return { ...result, fullCaptureFailure: await readFile(failure, "utf8") };
    }
    try {
      return await capture(request, snapshot, directory, signal, false, binary);
    } catch (error) {
      signal.throwIfAborted();
      if (!oversized(error)) throw error;
      const reason = captureFailure(error);
      try {
        await writeFile(failure, reason, { flag: "wx", mode: 0o600 });
      } catch (writeError) {
        if (
          !(
            writeError instanceof Error &&
            "code" in writeError &&
            writeError.code === "EEXIST"
          )
        )
          throw writeError;
      }
      const result = await capture(
        request,
        snapshot,
        scoped,
        signal,
        true,
        binary,
      );
      if (typeof result !== "object" || result === null)
        throw new Error("Invalid scoped analysis result");
      return { ...result, fullCaptureFailure: reason };
    }
  } catch (error) {
    signal.throwIfAborted();
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "PR Flow unavailable",
      alternativeEvidence:
        "Use the frozen diff and supplied evidence; do not infer low complexity from missing coverage.",
    };
  }
}
