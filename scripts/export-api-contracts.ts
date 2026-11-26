import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { roots, rootDescriptions, CommandSchema } from "../src/api/contracts.js";

interface SchemaNode {
  type?: string;
  description?: string;
  const?: string | number | boolean;
  enum?: string[];
  anyOf?: SchemaNode[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid contract schema");
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid contract array");
  return value;
}

function strings(value: unknown): string[] {
  return array(value).map((item) => {
    if (typeof item !== "string") throw new Error("Invalid contract string");
    return item;
  });
}

function node(value: unknown): SchemaNode {
  const raw = object(value),
    result: SchemaNode = {};
  if (typeof raw["type"] === "string") result.type = raw["type"];
  if (typeof raw["description"] === "string") result.description = raw["description"];
  const constant = raw["const"];
  if (typeof constant === "string" || typeof constant === "number" || typeof constant === "boolean")
    result.const = constant;
  if (raw["enum"] !== undefined) result.enum = strings(raw["enum"]);
  if (raw["anyOf"] !== undefined) result.anyOf = array(raw["anyOf"]).map(node);
  if (raw["items"] !== undefined) result.items = node(raw["items"]);
  if (raw["properties"] !== undefined)
    result.properties = Object.fromEntries(
      Object.entries(object(raw["properties"])).map(([key, item]) => [key, node(item)]),
    );
  if (raw["required"] !== undefined) result.required = strings(raw["required"]);
  return result;
}

const definitions: string[] = [];
type Shape =
  | { kind: "enum"; values: string[]; numbers: number[]; wireNames: string[] }
  | { kind: "literal"; scalar: string; value: string | number | boolean }
  | { kind: "list"; element: string }
  | { kind: "union"; variants: { type: string; field: string }[] }
  | {
      kind: "object";
      fields: { key: string; type: string; required: boolean }[];
    };
const shapes: Record<string, Shape> = {};
const snake = (value: string) =>
  value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
const pascal = (value: string) =>
  value
    .split(/[_-]/u)
    .map((s) => s.slice(0, 1).toUpperCase() + s.slice(1))
    .join("");
type WireTag = { number: number; type: string };
const manifestPath = "proto/api-wire-tags.json";
const tags: Record<string, Record<string, WireTag>> = {};
if (existsSync(manifestPath)) {
  const saved: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [name, value] of Object.entries(object(saved))) {
    const fields: Record<string, WireTag> = {};
    for (const [key, field] of Object.entries(object(value))) {
      const row = object(field),
        number = row["number"],
        type = row["type"];
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof type !== "string")
        throw new Error("Invalid API tag manifest");
      fields[key] = { number, type };
    }
    tags[name] = fields;
  }
}

function tag(name: string, key: string, type: string): number {
  const fields = tags[name] ?? {};
  tags[name] = fields;
  const prior = fields[key];
  if (prior !== undefined) {
    if (prior.type !== type) throw new Error(`API wire type changed: ${name}.${key}; bump the API version`);
    return prior.number;
  }
  const number = Math.max(0, ...Object.values(fields).map((value) => value.number)) + 1;
  fields[key] = { number, type };
  return number;
}

function reserved(name: string, used: number[]): string {
  const retired = Object.values(tags[name] ?? {})
    .map((value) => value.number)
    .filter((value) => !used.includes(value));
  return retired.length === 0 ? "" : `reserved ${retired.join(", ")};`;
}

function variantKey(schema: SchemaNode): string {
  if (schema.const !== undefined) return `literal:${String(schema.const)}`;
  const discriminator = Object.entries(schema.properties ?? {}).find(([, value]) => value.const !== undefined);
  if (discriminator !== undefined) return `${discriminator[0]}:${String(discriminator[1].const)}`;
  return (
    "fields:" +
    Object.keys(schema.properties ?? {})
      .sort()
      .join(",")
  );
}

function type(name: string, s: SchemaNode, purpose: string): string {
  const documentation = `// ${name} ${s.description ?? purpose}\n`;
  if (s.enum !== undefined) return type(name, { anyOf: s.enum.map((value) => ({ const: value })) }, purpose);
  if (s.anyOf !== undefined) {
    const branches = s.anyOf;
    if (branches.every((b) => typeof b.const === "string")) {
      const prefix = snake(name).toUpperCase(),
        values = branches.map((b) => String(b.const));
      const numbers = values.map((value) => tag(name, value, "enum"));
      const wireNames = values.map((value) => `${prefix}_${value.toUpperCase()}`);
      definitions.push(
        `enum ${name} { ${prefix}_UNSPECIFIED = 0; ${reserved(name, numbers)} ${wireNames.map((value, i) => `${value} = ${String(numbers[i])};`).join(" ")} }`,
      );
      shapes[name] = { kind: "enum", values, numbers, wireNames };
      return name;
    }
    const variants = branches.map((branch) => {
      const number = tag(name, variantKey(branch), "variant");
      return {
        type: type(name + "Variant" + String(number), branch, `represents ${variantKey(branch)} for ${name}.`),
        field: `variant${String(number)}`,
        number,
      };
    });
    definitions.push(
      `${documentation}message ${name} { ${reserved(
        name,
        variants.map((v) => v.number),
      )} oneof variant { ${variants.map((v) => `${v.type} variant_${String(v.number)} = ${String(v.number)};`).join(" ")} } }`,
    );
    shapes[name] = {
      kind: "union",
      variants: variants.map(({ type, field }) => ({ type, field })),
    };
    return name;
  }
  if (s.const !== undefined) {
    if (typeof s.const === "string") return type(name, { anyOf: [{ const: s.const }] }, purpose);
    const scalar = typeof s.const === "boolean" ? "bool" : "int64";
    definitions.push(`${documentation}message ${name} { optional ${scalar} literal = 1; }`);
    shapes[name] = { kind: "literal", scalar, value: s.const };
    return name;
  }
  if (s.type === "array") {
    const element = type(name + "Item", s.items ?? {}, `represents one item in ${name}.`);
    definitions.push(`${documentation}message ${name} { repeated ${element} items = 1; }`);
    shapes[name] = { kind: "list", element };
    return name;
  }
  if (s.type === "object") {
    const fields = Object.entries(s.properties ?? {}).map(([key, value]) => {
      const fieldType = type(name + pascal(key), value, `contains the ${key} value of ${name}.`),
        number = tag(name, key, fieldType);
      return {
        key,
        type: fieldType,
        number,
        required: (s.required ?? []).includes(key),
        declaration: `${["string", "int64", "double", "bool"].includes(fieldType) || shapes[fieldType]?.kind === "enum" ? "optional " : ""}${fieldType} ${snake(key)} = ${String(number)}${key.includes("_") ? ` [json_name = "${key}"]` : ""};`,
      };
    });
    definitions.push(
      `${documentation}message ${name} { ${reserved(
        name,
        fields.map((field) => field.number),
      )} ${fields.map((field) => field.declaration).join(" ")} }`,
    );
    shapes[name] = {
      kind: "object",
      fields: fields.map(({ key, type, required }) => ({
        key,
        type,
        required,
      })),
    };
    return name;
  }
  if (s.type === "string") return "string";
  if (s.type === "integer") return "int64";
  if (s.type === "number") return "double";
  if (s.type === "boolean") return "bool";
  throw new Error(`Untyped API field: ${name}`);
}

const descriptions: Readonly<Record<string, string>> = rootDescriptions;
for (const [name, schema] of Object.entries(roots)) {
  const purpose = descriptions[name];
  if (purpose === undefined) throw new Error(`Missing API documentation: ${name}`);
  type("Domain" + name, node(schema), purpose);
}
const operations: Record<string, string> = {
  auto_merge: "SetAutoMerge",
  queue: "QueueMergeChain",
  inspect: "InspectMergeChains",
  references: "ListPRReferences",
  dependencies: "ListPRDependencies",
  confirm: "ConfirmPRDependency",
  remove: "RemovePRDependency",
  decide: "DecidePRReference",
  policy: "SetMergePolicy",
  ready: "SetMergeReady",
  pause: "PauseMergeChain",
  resume: "ResumeMergeChain",
  cancel: "CancelMergeChain",
  reconcile: "ReconcileMergeOperation",
};
const requests: Record<string, string> = {};
for (const schema of node(CommandSchema).anyOf ?? []) {
  const { op, ...fields } = schema.properties ?? {};
  if (typeof op?.const !== "string") throw new Error("Missing operation discriminator");
  const operation = operations[op.const];
  if (operation === undefined) throw new Error("Unmapped operation");
  type(
    operation + "Request",
    {
      type: "object",
      properties: fields,
      required: (schema.required ?? []).filter((key) => key !== "op"),
    },
    `supplies the validated ${op.const} command arguments.`,
  );
  requests[op.const] = operation;
}
writeFileSync(
  "proto/octomanager/v2/domain.proto",
  '// Generated by scripts/export-api-contracts.ts; domain contracts define these fields.\nsyntax = "proto3";\npackage octomanager.v2;\noption go_package = "github.com/lanej/octo-manager/gen/octomanager/v2;octomanagerv2";\n' +
    definitions.join("\n") +
    "\n",
);
mkdirSync("src/gen/api", { recursive: true });
writeFileSync(
  "src/gen/api/shapes.ts",
  "// Generated by scripts/export-api-contracts.ts.\nexport const shapes: Record<string, Shape> = " +
    JSON.stringify(shapes, null, 2) +
    ';\nexport type Shape = {kind:"enum";values:string[];numbers:number[];wireNames:string[]}|{kind:"literal";scalar:string;value:string|number|boolean}|{kind:"list";element:string}|{kind:"union";variants:{type:string;field:string}[]}|{kind:"object";fields:{key:string;type:string;required:boolean}[]};\nexport const operations = ' +
    JSON.stringify(requests, null, 2) +
    " as const;\n",
);
writeFileSync(manifestPath, JSON.stringify(tags, null, 2) + "\n");
