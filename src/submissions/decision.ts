import {
  inspectMarkdown,
  scoreComplexity,
  type PrContract,
  type Evaluation,
  type Decision,
} from "./pr-contract.js";
import {
  publicationBlockers,
  applicable,
  type PrBrief,
  type RepositoryPolicy,
  type RepositorySnapshot,
} from "./contracts.js";
export function decide(
  brief: PrBrief,
  policy: RepositoryPolicy,
  snapshot: RepositorySnapshot,
  contract: PrContract,
  evaluation: Evaluation,
  diagramBlockers: string[],
  flow?: unknown,
): Decision {
  if (brief.change.factors === undefined)
    throw new Error("Missing complexity factor ratings");
  const { score, tier } = scoreComplexity(brief.change.factors, contract);
  const duplicateAssessments =
    new Set(evaluation.requirementChecks.map((check) => check.ruleId)).size !==
    evaluation.requirementChecks.length;
  const overrides = new Set(contract.pr.overrides.map((r) => r.rule_id));
  const blockers = contract.pr.overrides
    .filter(
      (r) =>
        r.rule_id !== "context.private-to-public" &&
        !policy.analysis.requirements.some((rule) => rule.id === r.rule_id),
    )
    .map((r) => `Unknown override rule ${r.rule_id}`);
  if (duplicateAssessments)
    blockers.push("Evaluator returned duplicate requirement assessments");
  const effectivePolicy = {
    ...policy,
    analysis: {
      ...policy.analysis,
      requirements: policy.analysis.requirements.filter(
        (rule) => !overrides.has(rule.id),
      ),
    },
  };
  const hasFlow =
    typeof flow === "object" &&
    flow !== null &&
    "available" in flow &&
    flow.available === true;
  const contextEvidence = [
    "purpose",
    "description",
    "flow-status",
    ...(hasFlow ? ["flow"] : []),
    ...(snapshot.references ?? []).map((_, i) => "reference:" + String(i)),
  ];
  const unknownRules = effectivePolicy.analysis.requirements.filter(
    (rule) =>
      rule.strength === "required" &&
      rule.check.kind === "semantic" &&
      applicable(rule, snapshot.files) &&
      !evaluation.requirementChecks.some(
        (check) => check.ruleId === rule.id && check.status !== "unknown",
      ),
  );
  const missingRequirements: string[] = [];
  blockers.push(
    ...publicationBlockers(
      {
        ...brief,
        draft: {
          ...brief.draft,
          requirementChecks: evaluation.requirementChecks,
        },
      },
      effectivePolicy,
      snapshot.files,
      contextEvidence,
    ).filter((message) => {
      if (
        unknownRules.some((rule) =>
          message.startsWith("Required " + rule.id + ":"),
        )
      ) {
        const rule = unknownRules.find((rule) =>
          message.startsWith("Required " + rule.id + ":"),
        );
        const assessment = evaluation.requirementChecks.find(
          (check) => check.ruleId === rule?.id,
        );
        missingRequirements.push(
          message +
            " Evidence needed: " +
            (assessment?.rationale ??
              "The evaluator did not assess this applicable requirement."),
        );
        return false;
      }
      return true;
    }),
    ...diagramBlockers,
  );
  const md = inspectMarkdown(brief.draft.body),
    profile = contract.pr.profiles[tier];
  if (md.words > profile.max_prose_words)
    blockers.push(
      `Prose budget exceeded: ${String(md.words)} > ${String(profile.max_prose_words)}`,
    );
  const limit = contract.pr.presentation.first_artifact_by_prose_word;
  if (
    md.words > limit &&
    (md.firstArtifact === undefined || md.firstArtifact > limit)
  )
    blockers.push(
      `Introduce an explanatory artifact by prose word ${String(limit)}`,
    );
  if (profile.require_diagram && md.diagrams.length === 0)
    blockers.push(
      "Complexity profile requires a source-backed Mermaid diagram",
    );
  if (
    md.links.some((link) =>
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/u.test(link),
    ) ||
    md.codeReferences.length > 0
  )
    blockers.push(
      "Use plain #NUMBER or owner/repo#NUMBER for native GitHub references",
    );
  const knownReferences = new Set(
    (snapshot.references ?? []).map(
      (ref) => `${ref.repository.toLowerCase()}#${String(ref.number)}`,
    ),
  );
  for (const ref of md.references) {
    const canonical = ref.startsWith("#")
      ? `${brief.request.repository.toLowerCase()}${ref}`
      : ref.toLowerCase();
    if (!knownReferences.has(canonical))
      blockers.push(`Unresolved GitHub reference: ${ref}`);
    if (
      canonical.startsWith(`${brief.request.repository.toLowerCase()}#`) &&
      !ref.startsWith("#")
    )
      blockers.push(
        `Use same-repository reference ${ref.slice(ref.indexOf("#"))}`,
      );
  }
  for (const match of brief.draft.body.matchAll(
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+((?:[\w.-]+\/[\w.-]+)?#[1-9]\d*)/giu,
  )) {
    if (!brief.request.purpose.toLowerCase().includes(match[0].toLowerCase()))
      blockers.push(
        "Closing keywords require an explicit resolution relationship in caller purpose",
      );
  }
  const ids = new Set([
    "diff",
    "purpose",
    "description",
    ...contextEvidence,
    ...brief.request.validation.map((_, i) => `validation:${String(i)}`),
    ...policy.sources.map((s) => `source:${s.path}`),
    ...(snapshot.references ?? []).map((_, i) => `reference:${String(i)}`),
  ]);
  for (const rating of brief.change.factors)
    if (rating.evidenceRefs.some((ref) => !ids.has(ref)))
      blockers.push(`Unknown complexity evidence for ${rating.factor}`);
  for (const finding of evaluation.findings)
    if (finding.evidenceRefs.some((ref) => !ids.has(ref)))
      blockers.push(`Unknown evaluation evidence for ${finding.ruleId}`);
  for (const required of [
    "problem-fidelity",
    "claim-support",
    "scanability",
    "artifact-quality",
  ])
    if (evaluation.findings.filter((f) => f.ruleId === required).length !== 1)
      blockers.push(`Evaluator must assess ${required} exactly once`);
  const invalid = evaluation.findings.filter((f) => f.status === "invalid");
  const missing = evaluation.findings.filter(
    (f) => f.status === "needs_evidence",
  );
  return {
    status:
      blockers.length > 0 || invalid.length > 0
        ? "invalid"
        : missing.length > 0 || missingRequirements.length > 0
          ? "needs_evidence"
          : "valid",
    score,
    tier,
    proseWords: md.words,
    blockers: [
      ...blockers,
      ...invalid.map((f) => f.message),
      ...missing.map((f) => f.message),
      ...missingRequirements,
    ],
    findings: evaluation.findings,
  };
}
