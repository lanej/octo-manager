import { repairProfile, type RepairProfile } from "../repairs/types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Blocker, ExecutionProfile } from "./types.js";
export interface TrackingConfig {
  repairs: Record<string, RepairProfile>;
  profiles: Record<string, ExecutionProfile>;
  rules: { kind: Blocker["kind"]; checkName?: string; profile: string }[];
  endpoints: Record<string, { socket?: string }>;
}
const kinds = ["conflict", "check_failed", "changes_requested"] as const;
const defaults: TrackingConfig = {
  repairs: {},
  profiles: Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        name: kind,
        instructions:
          kind === "conflict"
            ? "Inspect the conflicting branches and report the reconciliation needed."
            : kind === "check_failed"
              ? "Inspect the failed check and report the smallest correction."
              : "Inspect the requested changes and report what needs attention.",
      },
    ]),
  ),
  rules: [],
  endpoints: { local: {} },
};
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function defaultTrackingConfig(): TrackingConfig {
  return structuredClone(defaults);
}
export function loadTrackingConfig(path?: string): TrackingConfig {
  const target =
    path ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "octo-manager",
      "config.json",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    if (!path && (error as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(defaults);
    throw new Error("Invalid tracking configuration: could not read JSON");
  }
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) => !["profiles", "rules", "endpoints", "repairs"].includes(k),
    )
  )
    throw new Error("Invalid tracking configuration");
  const result = structuredClone(defaults);
  if (raw["repairs"] !== undefined) {
    if (!object(raw["repairs"])) throw new Error("Invalid repair profiles");
    for (const [name, profile] of Object.entries(raw["repairs"]))
      result.repairs[name] = repairProfile(profile);
  }
  if (raw.profiles !== undefined) {
    if (!object(raw.profiles)) throw new Error("Invalid profiles");
    for (const [name, p] of Object.entries(raw.profiles)) {
      if (
        !name ||
        !object(p) ||
        Object.keys(p).some(
          (k) => !["instructions", "harness", "model"].includes(k),
        ) ||
        typeof p.instructions !== "string" ||
        !p.instructions.trim() ||
        p.instructions.length > 8000 ||
        (p.harness !== undefined &&
          (typeof p.harness !== "string" || !p.harness)) ||
        (p.model !== undefined && (typeof p.model !== "string" || !p.model))
      )
        throw new Error("Invalid profile");
      result.profiles[name] = {
        name,
        instructions: p.instructions,
        ...(p.harness === undefined ? {} : { harness: p.harness as string }),
        ...(p.model === undefined ? {} : { model: p.model as string }),
      };
    }
  }
  if (raw.endpoints !== undefined) {
    if (!object(raw.endpoints)) throw new Error("Invalid endpoints");
    for (const [name, e] of Object.entries(raw.endpoints)) {
      if (
        !name ||
        !object(e) ||
        Object.keys(e).some((k) => k !== "socket") ||
        (e.socket !== undefined &&
          (typeof e.socket !== "string" || !e.socket.startsWith("/")))
      )
        throw new Error("Invalid endpoint socket");
      result.endpoints[name] = e as { socket?: string };
    }
  }
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) throw new Error("Invalid routing rules");
    result.rules = raw.rules.map((r) => {
      if (
        !object(r) ||
        Object.keys(r).some(
          (k) => !["kind", "checkName", "profile"].includes(k),
        ) ||
        !kinds.includes(r.kind as (typeof kinds)[number]) ||
        typeof r.profile !== "string" ||
        !Object.hasOwn(result.profiles, r.profile) ||
        (r.checkName !== undefined &&
          (r.kind !== "check_failed" ||
            typeof r.checkName !== "string" ||
            !r.checkName))
      )
        throw new Error("Invalid routing rule");
      return r as TrackingConfig["rules"][number];
    });
  }
  return result;
}
export function selectProfile(
  blocker: Blocker,
  config: TrackingConfig,
): ExecutionProfile {
  const rule = config.rules.find(
    (r) =>
      r.kind === blocker.kind &&
      (r.checkName === undefined ||
        (blocker.kind === "check_failed" && r.checkName === blocker.checkName)),
  );
  return structuredClone(config.profiles[rule?.profile ?? blocker.kind]!);
}
