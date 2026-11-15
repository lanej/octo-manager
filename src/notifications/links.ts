import { compact } from "../tracking/messages.js";

// GitHub resolves bare references in the source repository, not the receiving agent's repository.
export function linkPRReferences(
  text: string,
  sourceUrl?: string,
  knownUrl?: string,
  limit = 768,
): string {
  const repository =
    sourceUrl === undefined
      ? undefined
      : new URL(sourceUrl).pathname.split("/").slice(1, 3).join("/");
  const source =
    repository !== undefined &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      ? repository
      : undefined;
  const tokens: { text: string; atomic: boolean }[] = [];
  for (const [index, segment] of text
    .split(/(`+[^`]*`+|\[[^\]\n]*\]\([^)\n]*\))/gu)
    .entries()) {
    if (index % 2 === 1) {
      tokens.push({ text: segment, atomic: true });
      continue;
    }
    let previous = 0;
    for (const match of segment.matchAll(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[1-9][0-9]*\b(?:[/?#][^\s<>()[\]`"']*)?|(?<![\w/])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*\b/gu,
    )) {
      tokens.push({
        text: segment.slice(previous, match.index),
        atomic: false,
      });
      const value = match[0];
      let target: string | undefined;
      if (value.startsWith("https://")) target = value;
      else {
        const [qualified, number] = value.split("#");
        const repo = qualified === "" ? source : qualified;
        if (repo !== undefined && number !== undefined) {
          const known = knownUrl === undefined ? undefined : new URL(knownUrl);
          const expected = `${repo}/pull/${number}`.toLowerCase();
          target =
            known?.pathname.slice(1).toLowerCase() === expected
              ? knownUrl
              : `https://github.com/${repo}/issues/${number}`;
        }
      }
      const label =
        target === undefined
          ? undefined
          : new URL(target).pathname
              .slice(1)
              .replace(/\/(?:pull|issues)\//u, "#");
      tokens.push({
        text:
          target === undefined || label === undefined
            ? value
            : `[${compact(label, 120)}](${target})`,
        atomic: target !== undefined,
      });
      previous = match.index + value.length;
    }
    tokens.push({ text: segment.slice(previous), atomic: false });
  }
  let result = "";
  for (const token of tokens) {
    if (Buffer.byteLength(result + token.text) <= limit - 3) {
      result += token.text;
      continue;
    }
    const remaining = limit - Buffer.byteLength(result);
    if (!token.atomic && remaining > 3)
      return result + compact(token.text, remaining);
    return result.trimEnd() + "…";
  }
  return result;
}
