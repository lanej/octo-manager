import { expect, test } from "bun:test";
import {
  readContract,
  scoreComplexity,
  inspectMarkdown,
  validateDiagrams,
  factorNames,
} from "../src/submissions/pr-contract.js";
test("repository TOML applies partial overrides and rejects ambiguous configuration", () => {
  const value = readContract(
    "schema_version = 1\n[pr.profiles.routine]\nmax_prose_words = 80\n",
  );
  expect(value.pr.profiles.routine.max_prose_words).toBe(80);
  expect(value.pr.profiles.complex.require_diagram).toBe(true);
  expect(readContract().pr.profiles.routine.max_prose_words).toBe(100);
  for (const input of [
    "schema_version = 2",
    "schema_version = 1\n[pr]\nunknown = true",
    "schema_version = 1\n[pr.complexity]\nroutine_max = 20\nstandard_max = 10",
  ])
    expect(() => readContract(input)).toThrow();
});
test("weighted complexity has explicit boundary behavior and cannot omit a factor", () => {
  const factors = factorNames.map((factor) => ({
    factor,
    rating: 0,
    rationale: "No behavioral impact",
    evidenceRefs: ["diff"],
  }));
  expect(scoreComplexity(factors, readContract())).toEqual({
    score: 0,
    tier: "routine",
  });
  expect(
    scoreComplexity(
      factors.map((f) => ({ ...f, rating: 2 })),
      readContract(),
    ),
  ).toEqual({ score: 22, tier: "complex" });
  expect(() => scoreComplexity(factors.slice(1), readContract())).toThrow();
});
test("Markdown accounting excludes fenced code, includes table prose, and locates actual artifacts", () => {
  const parsed = inspectMarkdown(
    "Outcome first.\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n| Before | After |\n| --- | --- |\n| Lost state | Retained state |",
  );
  expect(parsed.words).toBe(8);
  expect(parsed.firstArtifact).toBe(2);
  expect(parsed.diagrams).toHaveLength(1);
  expect(
    inspectMarkdown("Text with a | character.").firstArtifact,
  ).toBeUndefined();
  expect(
    inspectMarkdown(
      "See `#123` and [a PR](https://github.com/owner/repo/pull/3).",
    ).codeReferences,
  ).toEqual(["#123"]);
});
test("Mermaid uses its real syntax parser", async () => {
  expect(await validateDiagrams(["flowchart LR\n A-->B"])).toEqual([]);
  expect(await validateDiagrams(["flowchart LR\n A --> ["])).toEqual([
    "Invalid Mermaid diagram 1",
  ]);
});

test("HTML screenshots and links participate in artifact and reference validation", () => {
  const parsed = inspectMarkdown(
    'Outcome.\n\n<img width="600" src="https://example.com/screenshot.png">\n<a href="https://github.com/o/r/pull/1">Related</a>',
  );
  expect(parsed.images).toEqual(["https://example.com/screenshot.png"]);
  expect(parsed.links).toContain("https://github.com/o/r/pull/1");
  expect(parsed.firstArtifact).toBe(1);
});

test("contract exceptions require a real reason and retain per-value configuration origins", () => {
  expect(() =>
    readContract(
      'schema_version = 1\n[[pr.overrides]]\nrule_id = "context.private-to-public"\nreason = "   "\n',
    ),
  ).toThrow("nonblank");
});
