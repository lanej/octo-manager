import {
  parseDocument,
  visit,
  isPair,
  isScalar,
  isSeq,
  isMap,
  isAlias,
} from "yaml";
import { isDeepStrictEqual } from "node:util";
export const yamlRecipe = "yaml-flow-sequence-v1";
export interface ConflictVersions {
  base: string;
  target: string;
  replayed: string;
}
interface Sequence {
  start: number;
  end: number;
  tokens: string[];
  values: unknown[];
  indent: string;
}
function inspect(source: string, inlineOnly = true): Map<string, Sequence> {
  if (source.includes("\r") || source.includes("\0"))
    throw new Error("Only LF text is eligible for this recipe");
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (
    doc.errors.length > 0 ||
    doc.warnings.length > 0 ||
    doc.directives.yaml.version !== "1.2"
  )
    throw new Error("YAML must parse unambiguously as version 1.2");
  const sequences = new Map<string, Sequence>();
  visit(doc, {
    Alias() {
      throw new Error("Aliases require a different recipe");
    },
    Node(_key, node) {
      if (
        node.tag !== undefined ||
        (!isAlias(node) && node.anchor !== undefined)
      )
        throw new Error("Tags and anchors require a different recipe");
    },
  });
  visit(doc, {
    Seq(_key, node, path) {
      if (
        (inlineOnly && node.flow !== true) ||
        node.range === undefined ||
        node.range === null ||
        node.items.length === 0 ||
        path.some((p) => isSeq(p) || (isMap(p) && p.flow === true))
      )
        return;
      if (node.items.length > 64)
        throw new Error("Sequence entry limit exceeded (64)");
      if (node.comment != null)
        throw new Error("Sequence comments require another recipe");
      const range = node.range;
      if (inlineOnly && source.slice(range[0], range[1]).includes("\n")) return;
      const tokens: string[] = [],
        values: unknown[] = [];
      for (const item of node.items) {
        if (
          !isScalar(item) ||
          item.range === undefined ||
          item.range === null ||
          item.tag !== undefined ||
          item.anchor !== undefined ||
          item.comment != null ||
          item.commentBefore != null
        )
          return;
        const value: unknown = item.value;
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        )
          return;
        tokens.push(source.slice(item.range[0], item.range[1]));
        values.push(value);
      }
      const keys: string[] = [];
      for (const parent of path) {
        if (isPair(parent)) {
          if (!isScalar(parent.key) || typeof parent.key.value !== "string")
            return;
          keys.push(parent.key.value);
        }
      }
      const line = source.slice(
        source.lastIndexOf("\n", range[0] - 1) + 1,
        range[0],
      );
      const indent = /^ */u.exec(line)?.[0] ?? "";
      sequences.set(JSON.stringify(keys), {
        start: range[0],
        end: range[1],
        tokens,
        values,
        indent,
      });
    },
  });
  return sequences;
}
export function expandInlineSequences(
  versions: ConflictVersions,
): ConflictVersions & { expected: Map<string, unknown[]> } {
  const maps = {
    base: inspect(versions.base),
    target: inspect(versions.target),
    replayed: inspect(versions.replayed),
  };
  const selected: string[] = [];
  const expected = new Map<string, unknown[]>();
  for (const [key, base] of maps.base) {
    const target = maps.target.get(key),
      replayed = maps.replayed.get(key);
    if (
      target !== undefined &&
      replayed !== undefined &&
      !isDeepStrictEqual(base.values, target.values) &&
      !isDeepStrictEqual(base.values, replayed.values)
    )
      selected.push(key);
  }
  if (
    selected.length > 16 ||
    selected.reduce(
      (count, key) => count + (maps.base.get(key)?.values.length ?? 0),
      0,
    ) > 256
  )
    throw new Error("Sequence comparison budget exceeded");
  for (const key of selected) {
    const base = maps.base.get(key),
      target = maps.target.get(key),
      replayed = maps.replayed.get(key);
    if (base === undefined || target === undefined || replayed === undefined)
      throw new Error("Missing sequence");
    if (
      base.values.length !== target.values.length ||
      base.values.length !== replayed.values.length
    )
      throw new Error("Sequence additions or deletions require another recipe");
    for (const values of [base.values, target.values, replayed.values]) {
      if (
        values.some((value, index) =>
          values.some(
            (other, position) =>
              position !== index && isDeepStrictEqual(value, other),
          ),
        )
      )
        throw new Error("Duplicate sequence entries require another recipe");
      if (
        values.some((value, index) =>
          base.values.some(
            (original, position) =>
              position !== index && isDeepStrictEqual(value, original),
          ),
        )
      )
        throw new Error("Sequence reorder requires another recipe");
    }
    const merged = base.values.map((original, index) => {
      const ours = target.values[index],
        theirs = replayed.values[index];
      if (
        !isDeepStrictEqual(original, ours) &&
        !isDeepStrictEqual(original, theirs) &&
        !isDeepStrictEqual(ours, theirs)
      )
        throw new Error("Both sides changed the same sequence element");
      return !isDeepStrictEqual(original, ours) ? ours : theirs;
    });
    expected.set(key, merged);
  }
  if (selected.length === 0)
    throw new Error("No matching inline sequence changed on both sides");
  const expand = (source: string, map: Map<string, Sequence>) => {
    let output = source;
    const edits = selected
      .map((key) => {
        const sequence = map.get(key);
        if (sequence === undefined) throw new Error("Missing sequence");
        return sequence;
      })
      .sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      const prefix = output.slice(0, edit.start).replace(/ +$/u, "");
      if (!prefix.endsWith(":"))
        throw new Error("Only mapping-value sequences are eligible");
      const replacement =
        "\n" +
        edit.tokens.map((token) => edit.indent + "  - " + token).join("\n");
      output = prefix + replacement + output.slice(edit.end);
    }
    const before: unknown = parseDocument(source).toJS({ mapAsMap: true });
    const parsed = parseDocument(output);
    const after: unknown = parsed.toJS({ mapAsMap: true });
    if (parsed.errors.length > 0 || !isDeepStrictEqual(before, after))
      throw new Error("Sequence expansion changed YAML data");
    return output;
  };
  return {
    base: expand(versions.base, maps.base),
    target: expand(versions.target, maps.target),
    replayed: expand(versions.replayed, maps.replayed),
    expected,
  };
}
export function validYamlCandidate(
  source: string,
  expected: Map<string, unknown[]>,
): boolean {
  try {
    const sequences = inspect(source, false);
    for (const [key, values] of expected) {
      if (!isDeepStrictEqual(sequences.get(key)?.values, values)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
