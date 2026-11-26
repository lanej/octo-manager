export function present<T>(value: T): NonNullable<T> {
  if (value == null) throw new Error("Expected a test fixture value");
  return value;
}
