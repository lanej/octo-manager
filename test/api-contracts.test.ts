import { test, expect } from "bun:test";
import { wire, unwire } from "../src/api/codec.js";
import {
  DomainPRReferenceSchema,
  DomainRepositoryPolicySchema,
  DomainCheckEvidenceSchema,
  DomainMergeReceiptResultSchema,
} from "../src/gen/octomanager/v2/domain_pb.js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { readFileSync, readdirSync } from "node:fs";
const roundtrip = (
  schema: import("@bufbuild/protobuf").DescMessage,
  value: unknown,
) => unwire(schema, fromBinary(schema, toBinary(schema, wire(schema, value))));
test("typed API preserves uncertain reference kinds, literal policy versions, and evidence coverage", () => {
  const reference = {
    id: "ref",
    prId: "pr",
    targetUrl: "https://github.com/o/r/issues/1",
    targetKind: "issue_or_pr",
    sourceKey: "comment",
    revision: "r",
    evidenceUrl: "https://github.com/o/r/pull/2",
    excerpt: "Depends on #1",
    hint: "depends_on",
    active: true,
    decision: "suggested",
    createdAt: 0,
  };
  expect(roundtrip(DomainPRReferenceSchema, reference)).toEqual(reference);
  for (const analystVersion of [1, 2, 3]) {
    const policy = {
      schemaVersion: 1,
      repository: "o/r",
      version: 1,
      sourceDigest: "digest",
      analystVersion,
      stockVersion: 1,
      createdAtMs: 0,
      sources: [],
      analysis: { requirements: [], template: "", blockers: [] },
    };
    expect(roundtrip(DomainRepositoryPolicySchema, policy)).toEqual(policy);
  }
  for (const evidence of [
    { state: "complete", value: [] },
    { state: "partial", value: [], reason: "Missing page" },
    { state: "unavailable", reason: "Rate limited" },
  ])
    expect(roundtrip(DomainCheckEvidenceSchema, evidence)).toEqual(evidence);
  expect(
    roundtrip(DomainMergeReceiptResultSchema, {
      receipt: "id",
      state: "queued",
    }),
  ).toEqual({ receipt: "id", state: "queued" });
  expect(() =>
    wire(DomainRepositoryPolicySchema, { schemaVersion: 2 }),
  ).toThrow();
});
test("v2 contract has no serialized-document or dynamic payload escape hatches", () => {
  for (const file of readdirSync("proto/octomanager/v2").filter((name) =>
    name.endsWith(".proto"),
  )) {
    const source = readFileSync("proto/octomanager/v2/" + file, "utf8");
    expect(source).not.toMatch(/\b(?:string|bytes)\s+\w*_json\b/u);
    expect(source).not.toMatch(/google\.protobuf\.(?:Struct|Value|Any)/u);
  }
});

test("regeneration retains committed wire IDs when domain property order changes", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import(
    "node:fs/promises"
  );
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "octo-wire-tags-"));
  const manifest = readFileSync("proto/api-wire-tags.json", "utf8");
  try {
    await mkdir(join(directory, "proto/octomanager/v2"), { recursive: true });
    await writeFile(join(directory, "proto/api-wire-tags.json"), manifest);
    const script = `import {roots} from ${JSON.stringify(resolve("src/api/contracts.ts"))};Object.defineProperty(roots.PRReference,"properties",{value:Object.fromEntries(Object.entries(roots.PRReference.properties).reverse())});await import(${JSON.stringify(resolve("scripts/export-api-contracts.ts"))});`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code, error).toBe(0);
    expect(
      await readFile(join(directory, "proto/api-wire-tags.json"), "utf8"),
    ).toBe(manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
