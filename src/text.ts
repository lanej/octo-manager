export function cleanText(value: string, limit = 16000): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, limit);
}
