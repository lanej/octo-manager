import { fromJson, toJson, type DescMessage, type MessageShape, type JsonValue } from "@bufbuild/protobuf";
import { shapes } from "../gen/api/shapes.js";
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid structured API record");
  return Object.fromEntries(Object.entries(value));
}
function convert(name: string, value: unknown, encode: boolean): JsonValue {
  if (name === "string") {
    if (typeof value !== "string") throw new Error("Invalid API text");
    return value;
  }
  if (name === "bool") {
    if (typeof value !== "boolean") throw new Error("Invalid API boolean");
    return value;
  }
  if (name === "int64" || name === "double") {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || (name === "int64" && !Number.isSafeInteger(number)))
      throw new Error("Invalid API number");
    return name === "int64" && encode ? String(number) : number;
  }
  const shape = shapes[name];
  if (shape === undefined) throw new Error(`Unknown API shape ${name}`);
  switch (shape.kind) {
    case "enum": {
      const index = encode
        ? shape.values.indexOf(typeof value === "string" ? value : "")
        : typeof value === "number"
          ? shape.numbers.indexOf(value)
          : shape.wireNames.indexOf(typeof value === "string" ? value : "");
      if (index < 0) throw new Error(`Invalid ${name} value`);
      return encode ? (shape.numbers[index] ?? 0) : (shape.values[index] ?? "");
    }
    case "literal": {
      const literal = convert(shape.scalar, encode ? value : record(value)["literal"], encode);
      const comparable = shape.scalar === "int64" ? Number(literal) : literal;
      if (comparable !== shape.value) throw new Error(`Invalid API literal ${name}`);
      return encode ? { literal } : comparable;
    }
    case "list": {
      const items = encode ? value : (record(value)["items"] ?? []);
      if (!Array.isArray(items)) throw new Error("Invalid API list");
      const converted = items.map((item: unknown) => convert(shape.element, item, encode));
      return encode ? { items: converted } : converted;
    }
    case "union": {
      if (!encode) {
        const input = record(value);
        const present = shape.variants
          .map((variant) => ({ variant: variant.type, key: variant.field }))
          .filter((v) => input[v.key] !== undefined);
        if (present.length !== 1) throw new Error("API variant must select one alternative");
        const selected = present[0];
        if (selected === undefined) throw new Error("Missing API variant");
        return convert(selected.variant, input[selected.key], false);
      }
      const matches = shape.variants.flatMap((variant) => {
        try {
          return [{ field: variant.field, value: convert(variant.type, value, true) }];
        } catch {
          return [];
        }
      });
      if (matches.length !== 1) throw new Error(`Invalid or ambiguous API variant ${name}`);
      const selected = matches[0];
      if (selected === undefined) throw new Error("Missing API variant");
      return { [selected.field]: selected.value };
    }
    case "object": {
      const input = record(value);
      const output: Record<string, JsonValue> = {};
      if (encode && Object.keys(input).some((key) => !shape.fields.some((field) => field.key === key)))
        throw new Error(`Unknown API field in ${name}`);
      for (const field of shape.fields) {
        const item = input[field.key];
        if (item === undefined) {
          if (field.required) throw new Error(`Invalid missing API field ${name}.${field.key}`);
          continue;
        }
        output[field.key] = convert(field.type, item, encode);
      }
      return output;
    }
  }
}
export function wire<S extends DescMessage>(schema: S, value: unknown): MessageShape<S> {
  const name = schema.name;
  return fromJson(schema, convert(name, value, true));
}
export function unwire<S extends DescMessage>(schema: S, value: MessageShape<S>): unknown {
  return convert(schema.name, toJson(schema, value), false);
}
