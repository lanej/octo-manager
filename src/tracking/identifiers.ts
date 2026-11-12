export function compactId(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}
export function shortId(id: string, ids: string[] = []): string {
  const normalized = compactId(id);
  if (!/^[a-f0-9]{32}$/.test(normalized)) return id;
  let length = 8;
  while (
    length < normalized.length &&
    ids.some(
      (other) =>
        other !== id &&
        compactId(other).startsWith(normalized.slice(0, length)),
    )
  )
    length++;
  return normalized.slice(0, length);
}
export function resolveId(id: string, ids: string[]): string | undefined {
  if (ids.includes(id)) return id;
  const prefix = compactId(id);
  if (!/^[a-f0-9]{8,32}$/.test(prefix)) return undefined;
  const matches = ids.filter((candidate) =>
    compactId(candidate).startsWith(prefix),
  );
  if (matches.length > 1)
    throw new Error("Invalid ambiguous ID prefix; use a longer ID");
  return matches[0];
}
