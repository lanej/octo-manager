import { cleanText } from "./domain.js";

export function workerResultText(
  kind: "structured" | "prose",
  text: string,
): string {
  switch (kind) {
    case "structured":
      if (Buffer.byteLength(text) > 65536)
        throw new Error("PR worker result exceeds limit");
      return text;
    case "prose":
      return cleanText(text);
  }
}
