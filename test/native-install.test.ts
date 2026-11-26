import { test, expect } from "bun:test";
import { serviceDefinition, startService } from "../src/install/service.js";
import { serviceCommand } from "../src/install/config.js";
import { packageRoot, workerModule } from "../src/package-root.js";
import { buildNative, validNativeCompiler, compilerRevision, compilerSource } from "../scripts/build-native.js";
import { resolve } from "node:path";

test("native installation selects the executable for both service managers and manual startup", async () => {
  const input = {
    home: "/fixture/home",
    release: "/fixture/release",
    state: "/fixture/state",
    path: "/usr/bin:/bin",
    configHome: "/fixture/config",
    codexHome: "/fixture/codex",
    executable: "/fixture/release/build/octo-manager",
  };
  expect(serviceCommand(input)).toEqual([input.executable]);
  const linux = serviceDefinition("linux", input, 501);
  expect(linux.text).toContain('ExecStart="/fixture/release/build/octo-manager" "serve"');
  const mac = serviceDefinition("darwin", input, 501);
  expect(mac.text).toContain(
    "<key>ProgramArguments</key><array><string>/fixture/release/build/octo-manager</string><string>serve</string></array>",
  );
  const manual = await startService(
    linux,
    input,
    true,
    () => {
      throw new Error("No service operation expected");
    },
    false,
    "a".repeat(64),
  );
  expect(manual.manualCommand).toContain("'/fixture/release/build/octo-manager' 'serve'");
});

test("source development retains module-relative roots and ordinary worker paths", () => {
  expect(packageRoot()).toBe(resolve(import.meta.dir, ".."));
  expect(workerModule("job", new URL("./fake-worker.mjs", import.meta.url).href)).toBe(
    resolve(import.meta.dir, "fake-worker.mjs"),
  );
});

test("stable Bun cannot masquerade as the selected native compiler by accepting --aot", () => {
  expect(() => buildNative(process.execPath, "/unused/native-output")).toThrow(
    "Select the verified native AOT compiler",
  );
});

test("native release reuse requires the selected compiler provenance", () => {
  const metadata = {
    revision: compilerRevision,
    source: compilerSource,
    sha256: "a".repeat(64),
  };
  expect(validNativeCompiler(metadata)).toBe(true);
  for (const invalid of [
    undefined,
    {},
    { ...metadata, revision: "1.4.5" },
    { ...metadata, source: "unknown" },
    { ...metadata, sha256: "unknown" },
  ])
    expect(validNativeCompiler(invalid)).toBe(false);
});
