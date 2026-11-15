import { test, expect } from "bun:test";
import { decide } from "../src/submissions/decision.js";
import {
  readContract,
  factorNames,
  type Evaluation,
} from "../src/submissions/pr-contract.js";
import {
  Complexity,
  type PrBrief,
  type RepositoryPolicy,
  type RepositorySnapshot,
} from "../src/submissions/contracts.js";
function fixture() {
  const request = {
    requestId: "decision",
    repository: "owner/repo",
    headRef: "feature",
    headSha: "a".repeat(40),
    baseRef: "main",
    purpose: "Keep state on return",
    validation: [],
    draft: false,
    owner: { harness: "codex" as const, endpoint: "local", sessionId: "test" },
  };
  const brief: PrBrief = {
    schemaVersion: 1,
    request,
    baseSha: "b".repeat(40),
    policyVersion: 1,
    change: {
      tier: Complexity.Routine,
      rationale: "One localized fix",
      outcome: "Keep selection",
      factors: factorNames.map((factor) => ({
        factor,
        rating: 0,
        rationale: "No broad impact",
        evidenceRefs: ["diff"],
      })),
      claims: [],
      limitations: [],
      blockers: [],
    },
    draft: {
      title: "fix: keep selection",
      body: "Keep selection when returning so navigation can continue.",
      requirementChecks: [],
      blockers: [],
    },
  };
  const snapshot: RepositorySnapshot = {
    repository: request.repository,
    headSha: request.headSha,
    baseSha: brief.baseSha,
    private: false,
    files: ["src/main.rs"],
    diff: "+keep_selection();",
    sources: [],
    sourceDigest: "fixture",
    references: [
      {
        repository: "owner/repo",
        private: false,
        number: 7,
        kind: "issue",
        title: "Lost selection",
        body: "Returning resets selection.",
        url: "https://github.com/owner/repo/issues/7",
        updatedAt: "2026-11-14T00:00:00Z",
      },
    ],
  };
  const policy: RepositoryPolicy = {
    schemaVersion: 1,
    repository: request.repository,
    version: 1,
    sourceDigest: "fixture",
    analystVersion: 3,
    stockVersion: 1,
    createdAtMs: 0,
    sources: [],
    analysis: { requirements: [], template: "", blockers: [] },
  };
  const evaluation: Evaluation = {
    findings: [
      "problem-fidelity",
      "claim-support",
      "scanability",
      "artifact-quality",
    ].map((ruleId) => ({
      ruleId,
      status: "valid",
      message: "Supported by the change",
      evidenceRefs: ["diff"],
    })),
    requirementChecks: [],
  };
  return { brief, snapshot, policy, evaluation };
}
test("resolved context and available flow are usable claim evidence, missing flow is not", () => {
  const f = fixture();
  f.brief.change.claims = [
    {
      statement: "Returning loses selection",
      falsification: "Issue reports retained selection",
      basis: "reported",
      evidenceRefs: ["reference:0"],
    },
  ];
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("valid");
  f.brief.change.claims[0]?.evidenceRefs.push("flow");
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("invalid");
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [], {
      available: true,
    }).status,
  ).toBe("valid");
});
test("unknown required semantic evidence stays needs_evidence and a demonstrated violation is invalid", () => {
  const f = fixture();
  f.policy.analysis.requirements.push({
    id: "tests",
    strength: "required",
    category: "workflow",
    description: "Run tests",
    sourcePath: "CONTRIBUTING.md",
    sourceSha: "source",
    line: 1,
    quote: "Run tests.",
    scope: "*",
    check: { kind: "semantic" },
  });
  f.evaluation.requirementChecks = [
    {
      ruleId: "tests",
      status: "unknown",
      rationale: "No test evidence was supplied.",
    },
  ];
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("needs_evidence");
  expect(
    decide(
      f.brief,
      f.policy,
      f.snapshot,
      readContract(),
      f.evaluation,
      [],
    ).blockers.join("\n"),
  ).toContain("No test evidence was supplied.");

  f.evaluation.requirementChecks = [
    {
      ruleId: "tests",
      status: "unmet",
      rationale: "Supplied test result is failing.",
    },
  ];
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("invalid");
});
test("hard prose budgets and native GitHub reference formatting cannot be self-approved", () => {
  const f = fixture();
  f.brief.draft.body = Array.from({ length: 101 }, () => "word").join(" ");
  expect(
    decide(
      f.brief,
      f.policy,
      f.snapshot,
      readContract(),
      f.evaluation,
      [],
    ).blockers.some((x) => x.includes("Prose budget")),
  ).toBe(true);
  f.brief.draft.body = "Keep selection. Related #7.";
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("valid");
  f.brief.draft.body =
    'Keep selection. <a href="https://github.com/owner/repo/pull/7">Related</a>';
  expect(
    decide(f.brief, f.policy, f.snapshot, readContract(), f.evaluation, [])
      .status,
  ).toBe("invalid");
});

test("contradictory semantic assessments cannot satisfy a required rule", () => {
  const f = fixture();
  f.policy.analysis.requirements.push({
    id: "tests",
    strength: "required",
    category: "workflow",
    description: "Run tests",
    sourcePath: "CONTRIBUTING.md",
    sourceSha: "source",
    line: 1,
    quote: "Run tests.",
    scope: "*",
    check: { kind: "semantic" },
  });
  f.evaluation.requirementChecks = [
    {
      ruleId: "tests",
      status: "satisfied",
      rationale: "Conflicting assessment.",
    },
    { ruleId: "tests", status: "unmet", rationale: "Tests failed." },
  ];
  const decision = decide(
    f.brief,
    f.policy,
    f.snapshot,
    readContract(),
    f.evaluation,
    [],
  );
  expect(decision.status).toBe("invalid");
  expect(decision.blockers).toContain(
    "Evaluator returned duplicate requirement assessments",
  );
});

test("complexity profile requires a diagram even when the evaluator approves short prose", () => {
  const f = fixture();
  for (const factor of f.brief.change.factors ?? []) factor.rating = 2;
  const decision = decide(
    f.brief,
    f.policy,
    f.snapshot,
    readContract(),
    f.evaluation,
    [],
  );
  expect(decision.score).toBe(22);
  expect(decision.tier).toBe("complex");
  expect(decision.status).toBe("invalid");
  expect(decision.blockers).toContain(
    "Complexity profile requires a source-backed Mermaid diagram",
  );
});
