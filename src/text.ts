export function cleanText(value: string, limit = 16000): string {
  const csi = /\[[0-?]*[ -/]*[@-~]/y;
  const bell = String.fromCharCode(7);
  let clean = "";

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 27) {
      if (value[i + 1] === "]") {
        const end = value.indexOf(bell, i + 2);
        i = end === -1 ? value.length : end;
        continue;
      }
      csi.lastIndex = i + 1;
      if (csi.test(value)) {
        i = csi.lastIndex - 1;
        continue;
      }
    }
    if ((code >= 32 && code !== 127) || code === 9 || code === 10) clean += value.charAt(i);
  }

  return clean.slice(0, limit);
}

// Subprocess and provider errors can contain unbounded output; retain the bounded diagnosis.
export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("name" in error && error.name === "AbortError") return "Operation aborted";
    if ("message" in error && typeof error.message === "string") return cleanText(error.message, 2000);
  }
  return cleanText(String(error), 2000);
}
