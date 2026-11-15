import { Check } from "typebox/value";
import { PublicSubmissionViewSchema } from "../src/submissions/public-contracts.js";
import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import {
  PrSubmissionInputSchema,
  PrContractSourceSchema,
} from "../src/gen/octomanager/v1/submissions_pb.js";
import {
  hash,
  type SubmissionInput,
  type Submission,
  type Role,
  SubmissionState,
} from "../src/submissions/contracts.js";
import { defaultContract } from "../src/submissions/pr-contract.js";
import {
  wireInput,
  inputFromWire,
  wireSubmission,
  submissionFromWire,
  wirePolicy,
  policyFromWire,
} from "../src/submissions/wire.js";
const input: SubmissionInput = {
  mode: "prepare",
  requestId: "typed-fixture",
  repository: "owner/repo",
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  purpose: "Explain fixture behavior",
  validation: [],
  draft: false,
  owner: { harness: "codex", endpoint: "local", sessionId: "wire-fixture" },
};
const description = {
  title: "docs: explain behavior",
  body: "Explain behavior so readers can understand the fixture.",
};
test("typed wire preserves presence, defaults, legacy identity, and malformed evidence", () => {
  expect(inputFromWire(wireInput(input))).toEqual(input);
  expect(inputFromWire(wireInput({ ...input, references: [] }))).toHaveProperty(
    "references",
    [],
  );
  expect(() =>
    wireInput({ ...input, contractToml: "not = [ valid" }),
  ).toThrow();
  expect(() =>
    wireInput({
      ...input,
      contractSource: { path: "caller", sha256: "digest" },
    }),
  ).toThrow("parsed contents");
  expect(() =>
    wireInput({
      ...input,
      contract: defaultContract,
      contractSource: {
        path: "caller",
        sha256: "digest",
        parseError: "bad config",
      },
    }),
  ).toThrow("parse errors");
  expect(() => inputFromWire(undefined)).toThrow("upgrade");
  expect(() => inputFromWire(create(PrSubmissionInputSchema))).toThrow();
  const record: Submission = {
    id: "fixture",
    request: { ...input, contractToml: "schema_version = 1\n" },
    state: SubmissionState.NeedsInput,
    detail: "Retained history",
    createdAt: 0,
    updatedAt: 1700000000123,
    stages: [],
    workerPids: [],
    notificationRevision: 0,
    preparedDigest: "retained-binding",
    images: [],
  };
  const original = structuredClone(record),
    digest = hash(record);
  for (const malformed of [
    null,
    "",
    [],
    { contractToml: "provider evidence, not configuration" },
  ]) {
    record.stages = [
      {
        role: "writer",
        model: "fixture",
        promptDigest: "fixture",
        raw: "",
        result: malformed,
        at: 0,
      },
    ];
    const wire = wireSubmission(record);
    expect(wire.stages?.items[0]?.result?.value.case).toBe("malformed");
    expect(submissionFromWire(wire).stages[0]?.result).toEqual(malformed);
  }
  record.stages = [];
  const decoded = submissionFromWire(wireSubmission(record));
  expect(decoded.request.contractToml).toBeUndefined();
  expect(decoded.request.contract).toEqual(defaultContract);
  expect(decoded.request.contractSource?.authoredPaths).toEqual([
    "schema_version",
  ]);
  expect(decoded.createdAt).toBe(0);
  expect(decoded.updatedAt).toBe(1700000000123);
  expect(decoded.images).toEqual([]);
  expect(decoded.preparedDigest).toBe("retained-binding");
  expect(record).toEqual(original);
  expect(hash(record)).toBe(digest);
  const invalidLegacy = submissionFromWire(
    wireSubmission({
      ...record,
      request: { ...input, contractToml: "not = [ valid" },
    }),
  );
  expect(invalidLegacy.request.contractToml).toBeUndefined();
  expect(invalidLegacy.request.contractSource?.parseError).toBeTruthy();
  const policy = {
    schemaVersion: 1 as const,
    repository: "owner/repo",
    version: 1,
    sourceDigest: "fixture",
    analystVersion: 3 as const,
    stockVersion: 1 as const,
    createdAtMs: 0,
    sources: [],
    analysis: {
      requirements: [
        {
          id: "prefix",
          strength: "required" as const,
          category: "title" as const,
          description: "Use docs",
          sourcePath: "CONTRIBUTING.md",
          sourceSha: "b",
          line: 1,
          quote: "Use docs",
          scope: "*",
          condition: "For docs",
          check: { kind: "title_prefix" as const, prefixes: ["docs:"] },
        },
      ],
      template: "",
      blockers: [],
    },
  };
  expect(policyFromWire(wirePolicy(policy))).toEqual(policy);
});
test("Connect prepares, reads, lists, and publishes typed submissions without changing durable digest material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-typed-rpc-"));
  let writes = 0;
  const roles: Role[] = [];
  const coordinator = new Coordinator(directory, {
    submissionOptions: {
      github: {
        snapshot: (request) =>
          Promise.resolve({
            repository: request.repository,
            headSha: request.headSha,
            baseSha: "b".repeat(40),
            private: false,
            files: ["example.md"],
            diff: "+Explain behavior.",
            sources: [],
            sourceDigest: "fixture",
          }),
        verify: () => Promise.resolve(),
        find: () => Promise.resolve(undefined),
        publish: (request, draft, marker) => {
          writes++;
          return Promise.resolve({
            url: "https://github.com/owner/repo/pull/10",
            headSha: request.headSha,
            headRepository: request.repository,
            headRef: request.headRef,
            baseSha: "b".repeat(40),
            targetBaseSha: "b".repeat(40),
            baseRef: request.baseRef,
            title: draft.title,
            body: `${draft.body}\n\n${marker}`,
            state: "open",
          });
        },
      },
      flow: () =>
        Promise.resolve({ available: false, reason: "Controlled test" }),
      instructions: (role) => Promise.resolve(`Controlled ${role}`),
      run: (role, _input, _schema, instructions, model) => {
        roles.push(role);
        const result =
          role === "change"
            ? {
                factors: [
                  "breadth",
                  "behavior",
                  "coupling",
                  "compatibility",
                  "state_risk",
                ].map((factor) => ({
                  factor,
                  rating: 0,
                  rationale: "Documentation only",
                  evidenceRefs: ["diff"],
                })),
                tier: "routine",
                rationale: "Small documentation fixture",
                outcome: "Explains behavior",
                claims: [],
                limitations: [],
                blockers: [],
              }
            : role === "evaluator"
              ? {
                  findings: [
                    "problem-fidelity",
                    "claim-support",
                    "scanability",
                    "artifact-quality",
                  ].map((ruleId) => ({
                    ruleId,
                    status: "valid",
                    message: "Controlled criterion",
                    evidenceRefs: ["diff"],
                  })),
                  requirementChecks: [],
                }
              : { ...description, requirementChecks: [], blockers: [] };
        return Promise.resolve({
          role,
          model,
          promptDigest: hash(instructions),
          raw: JSON.stringify(result),
          result,
          at: 0,
        });
      },
    },
  });
  try {
    await coordinator.start();
    const client = schedulerClient(directory);
    const invalidConfigInput = wireInput(input);
    invalidConfigInput.contractSource = create(PrContractSourceSchema, {
      path: "caller",
      sha256: "digest",
      parseError: "invalid configuration",
    });
    await assert.rejects(
      client.submitPullRequest({ input: invalidConfigInput }),
      /Invalid live configuration/u,
    );
    expect(coordinator.store.submissions.list()).toHaveLength(0);
    expect(writes).toBe(0);
    await assert.rejects(client.submitPullRequest({}), /upgrade/u);
    // Exercise the transport above its old 16 KiB limit, not just the codec.
    const largeInput: SubmissionInput = {
      ...input,
      mode: "policy",
      requestId: "large-typed-input",
      purpose: "x".repeat(12000),
      problem: "y".repeat(12000),
    };
    const large = submissionFromWire(
      (await client.submitPullRequest({ input: wireInput(largeInput) }))
        .submission,
    );
    expect(large.request.purpose).toBe(largeInput.purpose);
    expect(large.request.problem).toBe(largeInput.problem);
    const oversized: SubmissionInput = {
      ...input,
      requestId: "over-domain-limit",
      validation: Array.from({ length: 32 }, () => ({
        command: "check",
        result: "unknown",
        note: "z".repeat(8000),
      })),
    };
    await assert.rejects(
      client.submitPullRequest({ input: wireInput(oversized) }),
      /exceeds 240000 bytes/u,
    );
    const queued = submissionFromWire(
      (await client.submitPullRequest({ input: wireInput(input) })).submission,
    );
    expect(queued.request.draft).toBe(false);
    expect(queued.request.validation).toEqual([]);
    const wait = async (
      predicate: (value: Submission) => boolean,
      id = queued.id,
    ) => {
      for (let i = 0; i < 500; i++) {
        const value = coordinator.store.submissions.get(id);
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Typed submission timed out");
    };
    const prepared = await wait((v) => v.state === SubmissionState.Succeeded);
    expect(prepared.decision?.score).toBe(0);
    expect(writes).toBe(0);
    const viewed = submissionFromWire(
      (await client.getSubmission({ id: queued.id })).submission,
    );
    expect(viewed).toEqual(prepared);
    const savedPolicy = coordinator.store.submissions.policy(
      input.repository,
      prepared.policyVersion,
    );
    if (savedPolicy === undefined)
      throw new Error("Expected prepared repository policy");
    expect(
      policyFromWire(
        (
          await client.getRepositoryPolicy({
            repository: input.repository,
            tier: "routine",
          })
        ).policy,
      ),
    ).toEqual(savedPolicy);
    expect(Check(PublicSubmissionViewSchema, viewed)).toBe(true);
    expect(
      (await client.listSubmissions({})).submissions
        .map(submissionFromWire)
        .find((value) => value.id === queued.id),
    ).toEqual(prepared);
    expect(viewed.stages.map((s) => s.role)).toEqual([
      "change",
      "writer",
      "evaluator",
    ]);
    const wire = wireSubmission(prepared);
    expect(wire.stages?.items[0]?.result?.value.case).toBe("change");
    expect(wire.stages?.items[1]?.result?.value.case).toBe("writer");
    const before = hash(prepared);
    await client.getSubmission({ id: queued.id });
    expect(hash(coordinator.store.submissions.get(queued.id))).toBe(before);
    await client.publishPreparedPullRequest({ id: queued.id });
    const published = await wait(
      (v) => v.prUrl !== undefined && v.state === SubmissionState.Succeeded,
    );
    expect(published.preparedDigest).toBe(prepared.preparedDigest);
    expect(writes).toBe(1);
    expect(roles).toEqual(["change", "writer", "evaluator"]);
    // A historical request retains its immutable TOML/hash in storage, but reads as parsed content.
    const legacy = coordinator.submissions.submit({
      ...input,
      requestId: "historical",
      contractToml: "schema_version = 1\n",
    });
    const legacyPrepared = await wait(
      (v) => v.state === SubmissionState.Succeeded,
      legacy.id,
    );
    const legacyHash = hash(legacyPrepared.request);
    const publicLegacy = submissionFromWire(
      (await client.getSubmission({ id: legacy.id })).submission,
    );
    expect(Check(PublicSubmissionViewSchema, publicLegacy)).toBe(true);
    expect(publicLegacy.request.contractToml).toBeUndefined();
    expect(publicLegacy.request.contract).toEqual(defaultContract);
    expect(publicLegacy.preparedDigest).toBe(legacyPrepared.preparedDigest);
    expect(hash(coordinator.store.submissions.get(legacy.id).request)).toBe(
      legacyHash,
    );
    await client.publishPreparedPullRequest({ id: legacy.id });
    const legacyPublished = await wait(
      (v) => v.prUrl !== undefined && v.state === SubmissionState.Succeeded,
      legacy.id,
    );
    expect(legacyPublished.request.contractToml).toBe("schema_version = 1\n");
    expect(legacyPublished.preparedDigest).toBe(legacyPrepared.preparedDigest);
    expect(writes).toBe(2);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
