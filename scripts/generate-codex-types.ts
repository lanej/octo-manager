import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
const version = execFileSync("codex", ["--version"], {
  encoding: "utf8",
}).trim();
if (!version.endsWith("0.167.0"))
  throw new Error(
    "Generate with Codex 0.167.0; review protocol compatibility before upgrading",
  );
const scratch = mkdtempSync(join(tmpdir(), "octo-protocol-"));
try {
  execFileSync("codex", ["app-server", "generate-ts", "--out", scratch], {
    stdio: "pipe",
  });
  const visited = new Set<string>();
  function copy(path: string): void {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/from "([^"]+)"/g))
      copy(resolve(dirname(path), match[1]! + ".ts"));
    const target = join("src/agents/protocol", relative(scratch, path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.replace(/from "([^"]+)"/g, 'from "$1.js"'));
  }
  for (const file of [
    "InitializeParams.ts",
    "InitializeResponse.ts",
    "v2/ThreadReadParams.ts",
    "v2/ThreadResumeParams.ts",
    "v2/TurnStartParams.ts",
    "v2/ThreadTurnsListParams.ts",
  ])
    copy(join(scratch, file));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
