import {
  ActionState,
  type ActionEventContext,
  type TargetBase,
} from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
export function targetBase(value: unknown): TargetBase | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = json(value);
  if (
    !object(raw) ||
    typeof raw["ref"] !== "string" ||
    raw["ref"] === "" ||
    typeof raw["sha"] !== "string" ||
    raw["sha"] === ""
  )
    throw new Error("Invalid target base evidence");
  return { ref: raw["ref"], sha: raw["sha"] };
}
export function actionContext(value: unknown): ActionEventContext | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = json(value);
  if (!object(raw) || typeof raw["prUrl"] !== "string")
    throw new Error("Invalid action event context");
  const state = Object.values(ActionState).find(
    (state) => state === raw["state"],
  );
  if (state === undefined) throw new Error("Invalid action event state");
  const result: ActionEventContext = { state, prUrl: raw["prUrl"] };
  for (const key of [
    "actorAgentId",
    "actorHarness",
    "actorSessionId",
    "actorLabel",
  ] as const) {
    const field = raw[key];
    if (field !== undefined) {
      if (typeof field !== "string")
        throw new Error("Invalid action event actor");
      result[key] = field;
    }
  }
  return result;
}

export function trackingPR(value: unknown): {
  head: { sha: string };
  base: { sha: string; ref: string };
  state: "open" | "closed";
  merged: boolean;
  mergeable: unknown;
} {
  if (!object(value) || !object(value["head"]) || !object(value["base"]))
    throw new Error("Invalid GitHub PR observation");
  const head = value["head"],
    base = value["base"],
    state = value["state"];
  if (
    typeof head["sha"] !== "string" ||
    head["sha"] === "" ||
    typeof base["sha"] !== "string" ||
    base["sha"] === "" ||
    typeof base["ref"] !== "string" ||
    base["ref"] === "" ||
    !object(base["repo"]) ||
    typeof base["repo"]["private"] !== "boolean" ||
    (state !== "open" && state !== "closed")
  )
    throw new Error("Invalid GitHub PR observation");
  return {
    head: { sha: head["sha"] },
    base: { sha: base["sha"], ref: base["ref"] },
    state,
    merged: value["merged"] === true,
    mergeable: value["mergeable"],
  };
}
