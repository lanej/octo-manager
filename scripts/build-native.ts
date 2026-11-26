import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const compilerRevision = "1.4.6-canary.1+bfda77855";
export const compilerSource = "bfda7785587f737438d24f4a68a060a70071aa8f";
export function validNativeCompiler(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "revision" in value &&
    value.revision === compilerRevision &&
    "source" in value &&
    value.source === compilerSource &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}
export function buildNative(
  compiler: string,
  outfile: string,
  entrypoint = "src/executable.ts",
): {
  revision: string;
  source: string;
  sha256: string;
} {
  const executable = resolve(compiler);
  const run = (args: string[]) =>
    execFileSync(executable, args, {
      cwd: sourceRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  if (run(["--revision"]).trim() !== compilerRevision)
    throw new Error(
      `Select the verified native AOT compiler ${compilerRevision} explicitly with OCTO_AOT_BUN or --aot-bun; stable Bun ignores --aot.`,
    );
  const probe = mkdtempSync(join(tmpdir(), "octo-native-compiler-"));
  try {
    const source = join(probe, "probe.ts"),
      binary = join(probe, "probe");
    writeFileSync(
      source,
      'try { Array.prototype.push = function () { return 0; }; process.exit(1); } catch { console.log("native-aot"); }\n',
    );
    run(["compile", source, "--outfile", binary]);
    if (execFileSync(binary, [], { encoding: "utf8" }).trim() !== "native-aot")
      throw new Error("Compiler did not produce native AOT semantics");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  run(["compile", entrypoint, "--define=OCTO_NATIVE_AOT=true", "--sourcemap=external", "--outfile", outfile]);
  return {
    revision: compilerRevision,
    source: compilerSource,
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
}
if (import.meta.main) {
  const compiler = process.env["OCTO_AOT_BUN"];
  if (compiler === undefined || compiler === "")
    throw new Error(
      "Set OCTO_AOT_BUN to the explicitly selected native AOT compiler; no interpreted fallback is installed.",
    );
  const metadata = buildNative(compiler, join(sourceRoot, "build/octo-manager"));
  writeFileSync(join(sourceRoot, "build/native-compiler.json"), JSON.stringify(metadata) + "\n");
}
