export function cleanText(value: string, limit = 16000): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, limit);
}

// Subprocess and provider errors can contain unbounded output; retain the bounded diagnosis.
export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("name" in error && error.name === "AbortError")
      return "Operation aborted";
    if ("message" in error && typeof error.message === "string")
      return cleanText(error.message, 2000);
  }
  return cleanText(String(error), 2000);
}
