import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";
const text = (maxLength = 8000) => Type.String({ minLength: 1, maxLength });
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const strings = (maxItems = 100) => Type.Array(text(), { maxItems });
export const policyAnalystVersion = 3;
export function isPullRequestTemplate(path: string): boolean {
  return /^(?:\.github\/|docs\/)?pull_request_template(?:\.md|\/[^/]+\.md)$/iu.test(
    path,
  );
}
export enum SubmissionState {
  Queued = "queued",
  Analyzing = "analyzing",
  Writing = "writing",
  Publishing = "publishing",
  Enrolling = "enrolling",
  Succeeded = "succeeded",
  NeedsInput = "needs_input",
  Failed = "failed",
  Uncertain = "uncertain",
  Cancelled = "cancelled",
}
export enum Complexity {
  Routine = "routine",
  Standard = "standard",
  Complex = "complex",
}
export const OwnerSchema = object({
  harness: Type.Literal("codex"),
  endpoint: text(200),
  sessionId: text(200),
  label: Type.Optional(text(200)),
});
export const ValidationSchema = object({
  command: text(4000),
  result: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("not_run"),
    Type.Literal("unknown"),
  ]),
  note: Type.Optional(text()),
  evidenceUrl: Type.Optional(text(2000)),
});
export const SubmissionInputSchema = object({
  mode: Type.Optional(
    Type.Union([Type.Literal("publish"), Type.Literal("policy")]),
  ),
  requestId: text(200),
  repository: Type.String({
    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    maxLength: 200,
  }),
  headRef: text(300),
  headSha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  baseRef: text(300),
  purpose: text(16000),
  validation: Type.Array(ValidationSchema, { maxItems: 100 }),
  draft: Type.Boolean(),
  owner: OwnerSchema,
});
export const SourceSchema = object({
  path: text(4000),
  sha: text(100),
  text: Type.String({ maxLength: 131072 }),
});
export const RequirementSchema = object({
  id: text(100),
  strength: Type.Union([Type.Literal("required"), Type.Literal("recommended")]),
  category: Type.Union([
    Type.Literal("title"),
    Type.Literal("content"),
    Type.Literal("evidence"),
    Type.Literal("format"),
    Type.Literal("workflow"),
  ]),
  description: text(),
  sourcePath: text(4000),
  sourceSha: text(100),
  line: Type.Integer({ minimum: 1 }),
  quote: text(),
  condition: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 8000,
      description:
        "Exact unique applicability condition or contextual heading from the same cited source; omit for unconditional requirements.",
    }),
  ),
  scope: text(4000),
  check: Type.Union([
    object({ kind: Type.Literal("body_contains"), value: text() }),
    object({
      kind: Type.Literal("title_prefix"),
      prefixes: Type.Array(text(100), { minItems: 1, maxItems: 30 }),
    }),
    object({
      kind: Type.Literal("title_max_length"),
      maximum: Type.Integer({ minimum: 1, maximum: 1000 }),
    }),
    object({ kind: Type.Literal("evidence_required") }),
    object({ kind: Type.Literal("semantic") }),
  ]),
});
export const PolicyAnalysisSchema = object({
  requirements: Type.Array(RequirementSchema, { maxItems: 100 }),
  template: Type.String({ maxLength: 32000 }),
  blockers: strings(30),
});
const ProfileSchema = Type.Object(
  {
    minWords: Type.Integer({
      minimum: 0,
      description:
        "Advisory minimum description length; never pad a PR to meet it.",
    }),
    maxWords: Type.Integer({
      minimum: 1,
      description:
        "Advisory upper range; preserve required and material context.",
    }),
    guidance: text(),
    advisory: Type.Literal(true),
  },
  {
    additionalProperties: false,
    description:
      "Description size guidance selected by risk and semantic scope alongside change size. Repository requirements remain authoritative.",
  },
);
export const PolicySchema = object({
  complexityProfiles: Type.Optional(
    object({
      routine: ProfileSchema,
      standard: ProfileSchema,
      complex: ProfileSchema,
    }),
  ),
  schemaVersion: Type.Literal(1),
  repository: text(200),
  version: Type.Integer({ minimum: 1 }),
  sourceDigest: text(100),
  analystVersion: Type.Union([
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(policyAnalystVersion),
  ]),
  stockVersion: Type.Literal(1),
  createdAtMs: Type.Integer(),
  citationCorrections: Type.Optional(
    Type.Array(
      object({
        ruleId: text(100),
        reportedLine: Type.Integer({ minimum: 1 }),
        verifiedLine: Type.Integer({ minimum: 1 }),
      }),
    ),
  ),
  sources: Type.Array(SourceSchema, { maxItems: 100 }),
  analysis: PolicyAnalysisSchema,
});
export const ChangeAnalysisSchema = object({
  tier: Type.Enum(Complexity),
  rationale: text(),
  outcome: text(16000),
  claims: Type.Array(
    object({
      statement: text(),
      falsification: text(),
      evidenceRefs: strings(100),
      basis: Type.Union([
        Type.Literal("reported"),
        Type.Literal("observed"),
        Type.Literal("unverified"),
      ]),
    }),
    { maxItems: 100 },
  ),
  limitations: strings(30),
  blockers: strings(30),
});
export const WriterSchema = object({
  title: text(500),
  body: text(60000),
  requirementChecks: Type.Array(
    object({
      ruleId: text(100),
      status: Type.Union([
        Type.Literal("satisfied"),
        Type.Literal("unmet"),
        Type.Literal("unknown"),
        Type.Literal("not_applicable"),
      ]),
      rationale: text(),
    }),
    { maxItems: 100 },
  ),
  blockers: strings(30),
});
export const BriefSchema = object({
  schemaVersion: Type.Literal(1),
  request: SubmissionInputSchema,
  baseSha: text(100),
  policyVersion: Type.Integer({ minimum: 1 }),
  change: ChangeAnalysisSchema,
  draft: WriterSchema,
});
export type SubmissionInput = Static<typeof SubmissionInputSchema>;
export type Source = Static<typeof SourceSchema>;
export type Requirement = Static<typeof RequirementSchema>;
export type PolicyAnalysis = Static<typeof PolicyAnalysisSchema>;
export type RepositoryPolicy = Static<typeof PolicySchema>;
export type ChangeAnalysis = Static<typeof ChangeAnalysisSchema>;
export function normalizeChangeEvidence(
  change: ChangeAnalysis,
): ChangeAnalysis {
  return {
    ...change,
    claims: change.claims.map((claim) =>
      claim.basis === "observed" &&
      claim.evidenceRefs.some((ref) => ref.startsWith("validation:"))
        ? { ...claim, basis: "reported" }
        : claim,
    ),
  };
}
export type WriterDraft = Static<typeof WriterSchema>;
export type PrBrief = Static<typeof BriefSchema>;
export type Role = "policy" | "change" | "writer";
export const SnapshotSchema = object({
  repository: text(200),
  headSha: text(100),
  baseSha: text(100),
  private: Type.Boolean(),
  files: strings(300),
  diff: Type.String({ maxLength: 524288 }),
  sources: Type.Array(SourceSchema, { maxItems: 100 }),
  sourceDigest: text(100),
});
export const StageResultSchema = object({
  role: Type.Union([
    Type.Literal("policy"),
    Type.Literal("change"),
    Type.Literal("writer"),
  ]),
  model: text(200),
  promptDigest: text(100),
  raw: text(65536),
  result: Type.Unknown(),
  at: Type.Integer(),
});
export const SubmissionSchema = object({
  id: text(100),
  request: SubmissionInputSchema,
  state: Type.Enum(SubmissionState),
  detail: text(8000),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
  snapshot: Type.Optional(SnapshotSchema),
  policyVersion: Type.Optional(Type.Integer()),
  policyDigest: Type.Optional(text(100)),
  stages: Type.Array(StageResultSchema),
  brief: Type.Optional(BriefSchema),
  prUrl: Type.Optional(text(2000)),
  prId: Type.Optional(text(100)),
  workerPids: Type.Array(Type.Integer()),
  notificationRevision: Type.Integer(),
});
export type RepositorySnapshot = Static<typeof SnapshotSchema>;
export type StageResult = Static<typeof StageResultSchema>;
export type Submission = Static<typeof SubmissionSchema>;
export interface StageTask {
  kind: "pr_stage";
  role: Role;
  instructions: string;
  input: unknown;
  schema: TSchema;
}
export function parse(
  schema: typeof SubmissionInputSchema,
  value: unknown,
): Static<typeof SubmissionInputSchema>;
export function parse(
  schema: typeof PolicySchema,
  value: unknown,
): Static<typeof PolicySchema>;
export function parse(
  schema: typeof PolicyAnalysisSchema,
  value: unknown,
): Static<typeof PolicyAnalysisSchema>;
export function parse(
  schema: typeof ChangeAnalysisSchema,
  value: unknown,
): Static<typeof ChangeAnalysisSchema>;
export function parse(
  schema: typeof WriterSchema,
  value: unknown,
): Static<typeof WriterSchema>;
export function parse(
  schema: typeof BriefSchema,
  value: unknown,
): Static<typeof BriefSchema>;
export function parse(
  schema: typeof SnapshotSchema,
  value: unknown,
): Static<typeof SnapshotSchema>;
export function parse(
  schema: typeof StageResultSchema,
  value: unknown,
): Static<typeof StageResultSchema>;
export function parse(
  schema: typeof SubmissionSchema,
  value: unknown,
): Static<typeof SubmissionSchema>;
export function parse(schema: TSchema, value: unknown): unknown;
export function parse(schema: TSchema, value: unknown): unknown {
  if (!Check(schema, value)) throw new Error("Invalid structured PR data");
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const text: unknown = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("Invalid non-JSON data");
  return text;
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const stockProfiles: Record<
  Complexity,
  { minWords: number; maxWords: number; guidance: string; advisory: true }
> = {
  routine: {
    advisory: true,
    minWords: 20,
    maxWords: 100,
    guidance: "Localized, low risk, one clear outcome",
  },
  standard: {
    advisory: true,
    minWords: 100,
    maxWords: 250,
    guidance: "Related behaviors or decisions needing explanation",
  },
  complex: {
    advisory: true,
    minWords: 250,
    maxWords: 600,
    guidance:
      "Cross-boundary, migration, concurrency, security, breaking-change or rollout concerns",
  },
};
export function renderTemplate(
  policy: RepositoryPolicy,
  tier: Complexity,
): string {
  const profiles = policy.complexityProfiles ?? stockProfiles;
  return policy.analysis.template !== ""
    ? policy.analysis.template
    : `<What changes and why>\n\n<Concrete example when useful>\n\n<Material compatibility, limitations, or rollout details when applicable>\n\n<!-- Advisory ${String(profiles[tier].minWords)}–${String(profiles[tier].maxWords)} words; omit unused sections. -->`;
}
export function applicable(requirement: Requirement, files: string[]): boolean {
  return (
    requirement.scope === "*" ||
    files.some(
      (file) =>
        file === requirement.scope ||
        file.startsWith(requirement.scope.replace(/\/$/, "") + "/"),
    )
  );
}
export function policyBlockers(
  analysis: PolicyAnalysis,
  sources: Source[],
): string[] {
  const blockers = [...analysis.blockers];
  const ids = new Set<string>();
  for (const requirement of analysis.requirements) {
    if (ids.has(requirement.id))
      blockers.push(`Duplicate requirement ${requirement.id}`);
    ids.add(requirement.id);
    const source = sources.find(
      (source) =>
        source.path === requirement.sourcePath &&
        source.sha === requirement.sourceSha,
    );
    if (
      source === undefined ||
      !source.text
        .split("\n")
        .slice(
          requirement.line - 1,
          requirement.line - 1 + requirement.quote.split("\n").length,
        )
        .join("\n")
        .includes(requirement.quote)
    )
      blockers.push(`Unverified requirement citation: ${requirement.id}`);
    if (requirement.condition !== undefined) {
      const index = source?.text.indexOf(requirement.condition) ?? -1;
      if (
        requirement.condition.trim() === "" ||
        index < 0 ||
        source?.text.indexOf(requirement.condition, index + 1) !== -1
      )
        blockers.push(`Unverified applicability condition: ${requirement.id}`);
    }
  }
  return blockers;
}
export function publicationBlockers(
  brief: PrBrief,
  policy: RepositoryPolicy,
  files: string[],
): string[] {
  const checks = brief.draft.requirementChecks;
  const blockers = [
    ...brief.change.blockers,
    ...brief.draft.blockers,
    ...policy.analysis.blockers,
  ];
  if (brief.draft.title.trim().length === 0)
    blockers.push("PR title must not be blank");
  if (brief.draft.title.trimStart().startsWith("#"))
    blockers.push("PR title must be plain text, not a Markdown heading");
  if (
    !policy.analysis.requirements.some(
      (rule) =>
        rule.strength === "required" &&
        applicable(rule, files) &&
        rule.check.kind === "title_max_length" &&
        !checks.some(
          (check) =>
            check.ruleId === rule.id && check.status === "not_applicable",
        ),
    ) &&
    Array.from(brief.draft.title).length > 72
  )
    blockers.push("PR title must be at most 72 characters by default");
  if (brief.draft.body.trim().length === 0)
    blockers.push("PR body must not be blank");
  if (
    Array.from(brief.draft.title).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    blockers.push("PR title must be one printable line");
  if (
    /(?<![\w.])(?:\/Users\/|\/home\/\w|~\/|\/tmp\/|\/private\/(?:var|tmp)\/|\/var\/folders\/)|\blocalhost\b|127\.0\.0\.1|(?:file|vscode):\/\/|\]\((?:file:|vscode:|\/private\/)/u.test(
      `${brief.draft.title}\n${brief.draft.body}`,
    )
  )
    blockers.push(
      "Replace local-only links with durable evidence or describe the gap",
    );
  const evidence = new Set([
    "diff",
    ...brief.request.validation.map(
      (_, index) => `validation:${String(index)}`,
    ),
    ...policy.sources.map((source) => `source:${source.path}`),
  ]);
  for (const claim of brief.change.claims) {
    if (claim.evidenceRefs.some((ref) => !evidence.has(ref)))
      blockers.push(`Unknown evidence reference for claim: ${claim.statement}`);
    if (
      claim.basis === "observed" &&
      claim.evidenceRefs.some((ref) => ref.startsWith("validation:"))
    )
      blockers.push(
        "Caller-reported validation cannot be marked independently observed",
      );
  }
  for (const rule of policy.analysis.requirements.filter(
    (rule) => rule.strength === "required" && applicable(rule, files),
  )) {
    const assessment = checks.find((check) => check.ruleId === rule.id);
    if (assessment?.status === "not_applicable") {
      if (rule.condition === undefined || assessment.rationale.trim() === "")
        blockers.push(
          `Required ${rule.id}: not-applicable requires a verified source condition and rationale`,
        );
      continue;
    }
    let met: boolean;
    switch (rule.check.kind) {
      case "body_contains":
        met = brief.draft.body.includes(rule.check.value);
        break;
      case "title_prefix":
        met = rule.check.prefixes.some((prefix) =>
          brief.draft.title.startsWith(prefix),
        );
        break;
      case "title_max_length":
        met = Array.from(brief.draft.title).length <= rule.check.maximum;
        break;
      case "evidence_required":
        met = brief.request.validation.some(
          (entry) =>
            entry.evidenceUrl !== undefined || entry.note !== undefined,
        );
        break;
      case "semantic":
        met = checks.some(
          (check) => check.ruleId === rule.id && check.status === "satisfied",
        );
        break;
    }
    if (!met) blockers.push(`Required ${rule.id}: ${rule.description}`);
  }
  if (
    /TODO:\s*attach|<What changes|<Concrete example|<Material compatibility/i.test(
      brief.draft.body,
    )
  )
    blockers.push("Unfilled PR template placeholders");
  return blockers;
}

export function complexity(value: string): Complexity {
  switch (value) {
    case "routine":
      return Complexity.Routine;
    case "standard":
      return Complexity.Standard;
    case "complex":
      return Complexity.Complex;
    default:
      throw new Error("Invalid complexity tier");
  }
}

export function anchorPolicy(
  analysis: PolicyAnalysis,
  sources: Source[],
): {
  analysis: PolicyAnalysis;
  corrections: NonNullable<RepositoryPolicy["citationCorrections"]>;
} {
  const corrections: NonNullable<RepositoryPolicy["citationCorrections"]> = [];
  const requirements = analysis.requirements.map((requirement) => {
    const source = sources.find(
      (source) =>
        source.path === requirement.sourcePath &&
        source.sha === requirement.sourceSha,
    );
    if (source === undefined) return requirement;
    const index = source.text.indexOf(requirement.quote);
    if (index < 0 || source.text.indexOf(requirement.quote, index + 1) >= 0)
      return requirement;
    const line = source.text.slice(0, index).split("\n").length;
    if (line === requirement.line) return requirement;
    corrections.push({
      ruleId: requirement.id,
      reportedLine: requirement.line,
      verifiedLine: line,
    });
    return { ...requirement, line };
  });
  return { analysis: { ...analysis, requirements }, corrections };
}
