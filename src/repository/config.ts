import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Check } from "typebox/value";
import { ConfigSchema, StageSchema } from "./contracts.js";
import { autoMergeForStage } from "./policy.js";

function read(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536)
      throw new Error("Policy files must be regular files of at most 64 KiB");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
export function loadRepositoryConfig(root: string) {
  const toml = read(join(root, "octo-manager.toml"));
  if (toml === undefined)
    return {
      status: "missing" as const,
      hash: "missing",
      autoMerge: false,
      instructions: {},
    };
  const config: unknown = Bun.TOML.parse(toml);
  if (!Check(ConfigSchema, config))
    throw new Error("Invalid octo-manager.toml configuration");
  for (const text of Object.values(config.notifications?.instructions ?? {}))
    if (Buffer.byteLength(text) > 1000)
      throw new Error("Instruction text exceeds 1000 UTF-8 bytes");
  const manifest = read(join(root, ".source-code.json"));
  const installed: unknown =
    manifest === undefined ? undefined : JSON.parse(manifest);
  const stage =
    typeof installed === "object" &&
    installed !== null &&
    "schema_version" in installed &&
    installed.schema_version === 1 &&
    "stage" in installed &&
    Check(StageSchema, installed.stage)
      ? installed.stage
      : undefined;
  const configured = config.merging?.auto_merge ?? false;
  return {
    status: "valid" as const,
    hash: createHash("sha256")
      .update(toml)
      .update(manifest ?? "")
      .digest("hex"),
    ...(stage === undefined ? {} : { stage }),
    autoMerge: autoMergeForStage(configured, stage),
    instructions: config.notifications?.instructions ?? {},
  };
}
