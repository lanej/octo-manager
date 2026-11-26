import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryPolicyMonitor } from "../src/repository/monitor.js";
import { loadRepositoryConfig } from "../src/repository/config.js";

async function until(predicate: () => boolean) {
  const end = Date.now() + (process.env["CI"] === undefined ? 1500 : 10000);
  while (!predicate()) {
    if (Date.now() >= end)
      throw new Error("Repository file change was not observed");
    await Bun.sleep(5);
  }
}
test("policy file intake retains unchanged reads and observes replacement, deletion and recovery", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "octo-policy-monitor-")),
  );
  let loads = 0,
    changes = 0;
  const monitor = new RepositoryPolicyMonitor((path) => {
    loads++;
    return loadRepositoryConfig(path);
  });
  monitor.start(() => {
    changes++;
  });
  try {
    const config = join(directory, "octo-manager.toml");
    await writeFile(
      config,
      "schema_version = 1\n[merging]\nauto_merge = true\n",
    );
    await Bun.sleep(25);
    expect(monitor.read(directory)).toMatchObject({
      status: "valid",
      autoMerge: true,
    });
    for (let i = 0; i < 20; i++) monitor.read(directory);
    expect(loads).toBe(1);
    await writeFile(join(directory, "unrelated"), "does not invalidate policy");
    await Bun.sleep(25);
    monitor.read(directory);
    expect(loads).toBe(1);
    let before = changes;
    await writeFile(
      join(directory, "replacement"),
      "schema_version = 1\n[merging]\nauto_merge = false\n",
    );
    await rename(join(directory, "replacement"), config);
    await until(() => changes > before);
    expect(monitor.read(directory)).toMatchObject({
      status: "valid",
      autoMerge: false,
    });
    before = changes;
    await rm(config);
    await until(() => changes > before);
    expect(monitor.read(directory)).toMatchObject({
      status: "missing",
      autoMerge: false,
    });
    before = changes;
    await writeFile(
      config,
      "schema_version = 1\n[merging]\nauto_merge = true\n",
    );
    await until(() => changes > before);
    expect(monitor.read(directory)).toMatchObject({ autoMerge: true });
    monitor.invalidate();
    monitor.read(directory);
    expect(loads).toBe(5);
  } finally {
    monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy intake follows root replacement and fails closed while the root is missing", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "octo-policy-monitor-")),
  );
  const root = join(directory, "repo");
  const monitor = new RepositoryPolicyMonitor();
  let changes = 0;
  monitor.start(() => {
    changes++;
  });
  try {
    await mkdir(root);
    await writeFile(join(root, "octo-manager.toml"), "schema_version = 1\n");
    expect(monitor.read(root)).toMatchObject({ status: "valid" });
    await rename(root, join(directory, "old-repo"));
    await until(() => changes > 0);
    expect(monitor.read(root)).toBeInstanceOf(Error);
    expect(monitor.retryNeeded()).toBe(false);
    const missingChanges = changes;
    await mkdir(root);
    await writeFile(
      join(root, "octo-manager.toml"),
      "schema_version = 1\n[merging]\nauto_merge = true\n",
    );
    await until(() => changes > missingChanges);
    expect(monitor.read(root)).toMatchObject({
      status: "valid",
      autoMerge: true,
    });
    expect(monitor.retryNeeded()).toBe(false);
    const before = changes;
    await writeFile(
      join(root, ".source-code.json"),
      '{"schema_version":1,"stage":"beta"}',
    );
    await until(() => changes > before);
    expect(monitor.read(root)).toMatchObject({ stage: "beta" });
    monitor.retain(new Set());
    expect(monitor.retryNeeded()).toBe(false);
  } finally {
    monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing checkouts stay parked and unavailable-watch retries preserve healthy root caches", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "octo-policy-monitor-")),
  );
  const healthy = join(directory, "healthy");
  const absent = join(directory, "absent");
  const unavailable = join(directory, "missing-parent", "repo");
  const loads = new Map<string, number>();
  const monitor = new RepositoryPolicyMonitor((path) => {
    loads.set(path, (loads.get(path) ?? 0) + 1);
    return loadRepositoryConfig(path);
  });
  monitor.start(() => {});
  try {
    await mkdir(healthy);
    await writeFile(join(healthy, "octo-manager.toml"), "schema_version = 1\n");
    await Bun.sleep(25);
    expect(monitor.read(healthy)).toMatchObject({ status: "valid" });
    expect(monitor.read(absent)).toBeInstanceOf(Error);
    expect(monitor.retryNeeded()).toBe(false);
    expect(monitor.read(unavailable)).toBeInstanceOf(Error);
    expect(monitor.retryNeeded()).toBe(true);
    for (let i = 0; i < 4; i++) {
      monitor.retryUnavailable();
      monitor.read(healthy);
      monitor.read(absent);
      monitor.read(unavailable);
    }
    expect(loads.get(healthy)).toBe(1);
    expect(loads.has(absent)).toBe(false);
    await mkdir(unavailable, { recursive: true });
    await writeFile(
      join(unavailable, "octo-manager.toml"),
      "schema_version = 1\n",
    );
    monitor.retryUnavailable();
    expect(monitor.read(unavailable)).toMatchObject({ status: "valid" });
    expect(monitor.retryNeeded()).toBe(false);
    monitor.read(healthy);
    expect(loads.get(healthy)).toBe(1);
  } finally {
    monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});
