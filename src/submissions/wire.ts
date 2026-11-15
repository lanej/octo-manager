import { Code, ConnectError } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  Type,
  IsArray,
  IsInteger,
  IsObject,
  IsUnion,
  IsLiteral,
  type TSchema,
} from "typebox";
import { Check } from "typebox/value";
import {
  PrSubmissionInputSchema,
  PrSubmissionSchema,
  PrRepositoryPolicySchema,
  type PrSubmissionInput,
  type PrSubmission,
  type PrRepositoryPolicy,
} from "../gen/octomanager/v1/submissions_pb.js";
import {
  PublicInputSchema,
  PublicSubmissionSchema,
  projectConfig,
  parsedConfig,
  stageSchemas,
} from "./public-contracts.js";
import {
  PolicySchema,
  SubmissionInputSchema,
  SubmissionSchema,
  parse,
  type SubmissionInput,
  type Submission,
  type RepositoryPolicy,
} from "./contracts.js";

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, json(child)]),
    );
  throw new Error("Submission evidence is not JSON data");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected typed submission object");
  return Object.fromEntries(Object.entries(value));
}
// List messages preserve absent vs present-empty arrays; scalar presence preserves
// false/zero. Explicit json_name declarations preserve authored snake_case fields.
function encode(schema: TSchema, value: unknown): JsonValue {
  if (IsUnion(schema)) {
    const branch = schema.anyOf.find((candidate) => Check(candidate, value));
    if (branch === undefined)
      throw new Error("Invalid typed submission variant");
    if (IsObject(branch) && "kind" in branch.properties) {
      const object = record(value),
        kind = object["kind"];
      if (typeof kind !== "string") throw new Error("Invalid requirement kind");
      const payload = Object.fromEntries(
        Object.entries(object).filter(([key]) => key !== "kind"),
      );
      return { [kind]: encode(Type.Omit(branch, ["kind"]), payload) };
    }
    return encode(branch, value);
  }
  if (IsArray(schema)) {
    if (!Array.isArray(value)) throw new Error("Expected submission list");
    return { items: value.map((child) => encode(schema.items, child)) };
  }
  if (IsObject(schema)) {
    const object = record(value);
    return Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([key]) => object[key] !== undefined)
        .map(([key, child]) => [key, encode(child, object[key])]),
    );
  }
  if (IsInteger(schema)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new Error("Expected safe submission integer");
    return String(value);
  }
  return json(value);
}
function decode(schema: TSchema, value: unknown): unknown {
  if (IsUnion(schema)) {
    if (
      schema.anyOf.every(
        (candidate) => IsObject(candidate) && "kind" in candidate.properties,
      )
    ) {
      const object = record(value);
      if (Object.keys(object).length !== 1)
        throw new Error("Expected one requirement rule");
      for (const candidate of schema.anyOf) {
        if (!IsObject(candidate)) continue;
        const kind = candidate.properties["kind"];
        if (
          kind === undefined ||
          !IsLiteral(kind) ||
          typeof kind.const !== "string" ||
          !(kind.const in object)
        )
          continue;
        const payload = record(
          decode(Type.Omit(candidate, ["kind"]), object[kind.const]),
        );
        const result = { ...payload, kind: kind.const };
        if (!Check(candidate, result))
          throw new Error("Invalid requirement rule");
        return result;
      }
      throw new Error("Unsupported requirement rule");
    }
    for (const candidate of schema.anyOf) {
      try {
        const decoded = decode(candidate, value);
        if (Check(candidate, decoded)) return decoded;
      } catch {
        /* Try the next declared variant. */
      }
    }
    throw new Error("Invalid typed submission variant");
  }
  if (IsArray(schema)) {
    const wrapper = record(value),
      items = wrapper["items"] ?? [];
    if (
      Object.keys(wrapper).some((key) => key !== "items") ||
      !Array.isArray(items)
    )
      throw new Error("Invalid typed submission list");
    return items.map((child) => decode(schema.items, child));
  }
  if (IsObject(schema)) {
    const object = record(value);
    if (Object.keys(object).some((key) => !(key in schema.properties)))
      throw new Error("Unknown typed submission field");
    return Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([key]) => object[key] !== undefined)
        .map(([key, child]) => [key, decode(child, object[key])]),
    );
  }
  if (IsInteger(schema)) {
    if (
      typeof value !== "string" ||
      !/^-?\d+$/u.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error("Invalid submission integer");
    return Number(value);
  }
  return value;
}
export function wireInput(value: SubmissionInput) {
  const { contractToml, ...input } = value;
  if (contractToml !== undefined && value.contract !== undefined)
    throw new ConnectError(
      "Invalid mixed legacy and structured configuration",
      Code.InvalidArgument,
    );
  const projected =
    contractToml === undefined
      ? input
      : {
          ...input,
          ...parsedConfig(
            contractToml,
            value.contractSource?.path ?? "legacy caller configuration",
          ),
        };
  validateLiveConfig(projected);
  if (!Check(PublicInputSchema, projected))
    throw new Error("Invalid public submission input");
  return fromJson(
    PrSubmissionInputSchema,
    encode(PublicInputSchema, projected),
  );
}
function validateLiveConfig(value: SubmissionInput): void {
  if (
    value.contractSource !== undefined &&
    (value.contract === undefined ||
      value.contractSource.parseError !== undefined)
  ) {
    throw new ConnectError(
      "Invalid live configuration: parsed contents are required and parse errors cannot be submitted",
      Code.InvalidArgument,
    );
  }
}
export function inputFromWire(
  value: PrSubmissionInput | undefined,
): SubmissionInput {
  if (value === undefined)
    throw new ConnectError(
      "Typed submission input required; upgrade the CLI and coordinator together",
      Code.InvalidArgument,
    );
  const input = parse(
    SubmissionInputSchema,
    decode(PublicInputSchema, toJson(PrSubmissionInputSchema, value)),
  );
  validateLiveConfig(input);
  return input;
}
export function wireSubmission(value: Submission) {
  const projected = {
    ...value,
    request: projectConfig(value.request),
    ...(value.snapshot === undefined
      ? {}
      : { snapshot: projectConfig(value.snapshot) }),
    ...(value.brief === undefined
      ? {}
      : {
          brief: {
            ...value.brief,
            request: projectConfig(value.brief.request),
          },
        }),
    stages: value.stages.map((stage) => {
      const schema = stageSchemas[stage.role];
      return {
        ...stage,
        result: {
          [schema !== undefined && Check(schema, stage.result)
            ? stage.role
            : "malformed"]: stage.result,
        },
      };
    }),
  };
  if (!Check(PublicSubmissionSchema, projected))
    throw new Error("Invalid public submission record");
  return fromJson(
    PrSubmissionSchema,
    encode(PublicSubmissionSchema, projected),
  );
}
export function submissionFromWire(
  value: PrSubmission | undefined,
): Submission {
  if (value === undefined)
    throw new Error(
      "Typed submission response required; upgrade the CLI and coordinator together",
    );
  const decoded = decode(
    PublicSubmissionSchema,
    toJson(PrSubmissionSchema, value),
  );
  if (!Check(PublicSubmissionSchema, decoded))
    throw new Error("Invalid public submission response");
  return parse(SubmissionSchema, {
    ...decoded,
    stages: decoded.stages.map((stage) => ({
      ...stage,
      result: Object.entries(stage.result).map(([kind, result]) => {
        if (kind !== "malformed" && kind !== stage.role)
          throw new Error("Stage result disagrees with its role");
        return result;
      })[0],
    })),
  });
}
export function wirePolicy(value: RepositoryPolicy) {
  return fromJson(PrRepositoryPolicySchema, encode(PolicySchema, value));
}
export function policyFromWire(
  value: PrRepositoryPolicy | undefined,
): RepositoryPolicy {
  if (value === undefined)
    throw new Error("Typed repository policy response required");
  return parse(
    PolicySchema,
    decode(PolicySchema, toJson(PrRepositoryPolicySchema, value)),
  );
}
