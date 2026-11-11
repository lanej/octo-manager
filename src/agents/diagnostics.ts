import { cleanText } from "../domain.js";

export function codexVersion(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("userAgent" in value) ||
    typeof value.userAgent !== "string"
  )
    return undefined;
  return value.userAgent.match(/\/(\d+\.\d+\.\d+[^ ]*)/)?.[1];
}
export function rpcRejection(
  method: string,
  error: unknown,
  version?: string,
): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
      ? error.code
      : "unknown";
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "No upstream message";
  return `Codex ${method} rejected (RPC ${String(code)}${version !== undefined && version !== "" ? `, runtime ${version}` : ""}): ${cleanText(message, 2000).replace(/\s+/g, " ")}`;
}
