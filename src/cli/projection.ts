export type Projection = (value: unknown) => unknown;

export function fields(keys: readonly string[], children: Readonly<Record<string, Projection>> = {}): Projection {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Expected an object in CLI response");
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const child = children[key];
      if (child) result[key] = child(item);
      else if (keys.includes(key)) result[key] = item;
    }
    return result;
  };
}

export function rows(project: Projection): Projection {
  return (value) => {
    if (!Array.isArray(value)) throw new Error("Expected a CLI response array");
    const items: unknown[] = value;
    return items.map(project);
  };
}
