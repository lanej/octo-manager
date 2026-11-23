import { readFileSync } from "node:fs";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("engines" in manifest) ||
  typeof manifest.engines !== "object" ||
  manifest.engines === null ||
  !("bun" in manifest.engines) ||
  typeof manifest.engines.bun !== "string" ||
  !/^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(manifest.engines.bun)
)
  throw new Error(
    "Declare a Bun minimum as >=major.minor.patch in package.json engines.bun",
  );

export const bunRequirement = manifest.engines.bun;

export function requireBun(version: string | undefined): void {
  if (version === undefined || !Bun.semver.satisfies(version, bunRequirement))
    throw new Error(
      `Octo Manager requires Bun ${bunRequirement} on PATH; found ${version ?? "no Bun runtime"}. Install or upgrade Bun in the environment.`,
    );
}
