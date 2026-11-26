import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { requireBun } from "../src/runtime.js";

test("Bun minimum accepts the floor and newer releases, and rejects insufficient runtimes", () => {
  for (const version of ["1.4.4", "1.4.5", "1.5.0", "2.0.0"])
    expect(() => {
      requireBun(version);
    }).not.toThrow();
  for (const version of [undefined, "1.4.3", "1.3.99", "1.4.4-canary", "invalid"])
    expect(() => {
      requireBun(version);
    }).toThrow("requires Bun >=1.4.4");
});

for (const version of [undefined, "1.4.3"]) {
  test(`installer rejects ${version ?? "missing"} PATH Bun before creating installation or state`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "octo-runtime-"));
    try {
      const bin = join(fixture, "bin");
      await mkdir(bin);
      if (version !== undefined)
        await writeFile(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
          mode: 0o755,
        });
      const home = join(fixture, "home");
      const state = join(fixture, "state");
      const child = Bun.spawn([process.execPath, "scripts/install-local.ts", "--home", home, "--no-start"], {
        env: { ...process.env, PATH: bin, OCTO_MANAGER_STATE: state },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(stderr).toContain("requires Bun >=1.4.4");
      expect(existsSync(home)).toBe(false);
      expect(existsSync(state)).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("CLI checks the environment runtime before creating coordinator state", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "octo-runtime-start-"));
  try {
    const state = join(fixture, "state");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'Object.defineProperty(process.versions, "bun", { value: "1.4.3" }); await import("./src/cli.ts");',
        "serve",
      ],
      {
        env: { ...process.env, OCTO_MANAGER_STATE: state },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain("requires Bun >=1.4.4");
    expect(existsSync(state)).toBe(false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
