import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import {
  SubmissionInputSchema,
  SnapshotSchema,
  BriefSchema,
  StageResultSchema,
  SubmissionSchema,
  PolicyAnalysisSchema,
  ChangeAnalysisSchema,
  WriterSchema,
} from "./contracts.js";
import {
  EvaluationSchema,
  readContract,
  explainContract,
} from "./pr-contract.js";

// Legacy TOML remains in immutable durable records, never in the public API.
export const PublicInputSchema = Type.Omit(SubmissionInputSchema, [
  "contractToml",
]);
export const PublicSnapshotSchema = Type.Omit(SnapshotSchema, ["contractToml"]);
export const PublicBriefSchema = Type.Object(
  {
    ...BriefSchema.properties,
    request: PublicInputSchema,
  },
  { additionalProperties: false },
);
export const StageOutputSchema = Type.Union([
  Type.Object(
    { policy: PolicyAnalysisSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { change: ChangeAnalysisSchema },
    { additionalProperties: false },
  ),
  Type.Object({ writer: WriterSchema }, { additionalProperties: false }),
  Type.Object({ evaluator: EvaluationSchema }, { additionalProperties: false }),
  // Malformed provider output is evidence, not a successfully typed assessment.
  Type.Object({ malformed: Type.Unknown() }, { additionalProperties: false }),
]);
export const PublicStageSchema = Type.Object(
  {
    ...StageResultSchema.properties,
    result: StageOutputSchema,
  },
  { additionalProperties: false },
);
export const FlowSchema = Type.Object(
  {
    available: Type.Boolean(),
    scope: Type.Optional(Type.String()),
    analysisId: Type.Optional(Type.String()),
    schemaVersion: Type.Optional(Type.Integer()),
    coverage: Type.Optional(
      Type.Object(
        {
          total_nodes: Type.Optional(Type.Integer({ minimum: 0 })),
          shown_nodes: Type.Optional(Type.Integer({ minimum: 0 })),
          omitted_context_nodes: Type.Optional(Type.Integer({ minimum: 0 })),
          collapsed_detail_nodes: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    nodeCount: Type.Optional(Type.Integer()),
    edgeCount: Type.Optional(Type.Integer()),
    nodes: Type.Optional(Type.Array(Type.Unknown())),
    edges: Type.Optional(Type.Array(Type.Unknown())),
    interactions: Type.Optional(Type.Array(Type.Unknown())),
    interactionCount: Type.Optional(Type.Integer()),
    diagnostics: Type.Optional(Type.Array(Type.Unknown())),
    limited: Type.Optional(Type.Boolean()),
    fullCaptureFailure: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    alternativeEvidence: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const PublicSubmissionSchema = Type.Object(
  {
    ...SubmissionSchema.properties,
    request: PublicInputSchema,
    snapshot: Type.Optional(PublicSnapshotSchema),
    brief: Type.Optional(PublicBriefSchema),
    stages: Type.Array(PublicStageSchema),
    flow: Type.Optional(FlowSchema),
  },
  { additionalProperties: false },
);
// The CLI restores retained worker output to its original JSON shape; protobuf
// clients use PublicSubmissionSchema's explicit assessment/malformed variants.
export const PublicSubmissionViewSchema = Type.Object(
  {
    ...PublicSubmissionSchema.properties,
    stages: Type.Array(StageResultSchema),
  },
  { additionalProperties: false },
);
export const stageSchemas: Record<string, TSchema> = {
  policy: PolicyAnalysisSchema,
  change: ChangeAnalysisSchema,
  writer: WriterSchema,
  evaluator: EvaluationSchema,
};
export function parsedConfig(toml: string, path: string, blobSha?: string) {
  return {
    contract: readContract(toml),
    contractSource: {
      path,
      sha256: createHash("sha256").update(toml).digest("hex"),
      ...(blobSha === undefined ? {} : { blobSha }),
      authoredPaths: explainContract(toml, path)
        .values.filter((v) => v.origin === path)
        .map((v) => v.path),
    },
  };
}
export function projectConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const result = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "contractToml"),
  );
  if ("contractToml" in value && typeof value.contractToml === "string") {
    try {
      const parsed = parsedConfig(
        value.contractToml,
        "legacy recorded configuration",
      );
      result["contract"] ??= parsed.contract;
      result["contractSource"] ??= parsed.contractSource;
    } catch (error) {
      result["contractSource"] ??= {
        path: "legacy recorded configuration",
        sha256: createHash("sha256").update(value.contractToml).digest("hex"),
        parseError:
          error instanceof Error
            ? error.message.slice(0, 8000)
            : "Legacy configuration could not be parsed",
      };
    }
  }
  return result;
}
