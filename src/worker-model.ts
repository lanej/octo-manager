export type WorkerProvider = "openai-codex" | "amazon-bedrock";

export interface WorkerModel {
  provider: WorkerProvider;
  id: string;
}

export function workerModel(selector: string): WorkerModel {
  if (selector === "" || selector.trim() !== selector) {
    throw new Error("Invalid worker model");
  }
  const separator = selector.indexOf("/");
  if (separator === -1) return { provider: "openai-codex", id: selector };
  const provider = selector.slice(0, separator);
  const id = selector.slice(separator + 1);
  if (id === "") throw new Error("Invalid worker model");
  switch (provider) {
    case "openai-codex":
    case "amazon-bedrock":
      return { provider, id };
    default:
      throw new Error("Unsupported worker provider");
  }
}
