import assert from "node:assert/strict";
import { expect, spyOn, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assembleApplication,
  createApplication,
} from "../src/application/composition.js";
import { ApplicationInputs } from "../src/application/inputs.js";
import { Store, type InputScope } from "../src/coordinator/store.js";

async function directory() {
  return mkdtemp(join(tmpdir(), "octo-application-"));
}

test("early inputs retain revisions and coalesce wakes until the complete graph is bound", () => {
  const inputs = new ApplicationInputs();
  inputs.changed({ prId: "A" });
  inputs.jobs();
  inputs.jobs();
  inputs.recipient("owner");
  inputs.recipient("owner");
  inputs.changed();
  inputs.changed({ prId: "B", recipients: "all" });
  const changed: Array<InputScope | undefined> = [],
    recipients: string[] = [];
  let jobs = 0;
  expect(inputs.referenceRevision("A")).toBe("1:1");
  expect(inputs.referenceRevision("B")).toBe("1:3");
  expect(inputs.broadRevision()).toBe("2");
  inputs.bind({
    changed: (scope) => {
      changed.push(scope);
    },
    jobs: () => {
      jobs++;
    },
    recipient: (id) => {
      recipients.push(id);
    },
  });
  expect(changed).toEqual([undefined]);
  expect(jobs).toBe(1);
  expect(recipients).toEqual(["owner"]);
  expect(inputs.referenceRevision("B")).toBe("1:3");
  inputs.changed({ prId: "A" });
  expect(changed).toEqual([undefined, { prId: "A" }]);
  expect(inputs.referenceRevision("A")).toBe("1:4");
  expect(inputs.broadRevision()).toBe("2");
  expect(() => {
    inputs.bind({ changed: () => {}, jobs: () => {}, recipient: () => {} });
  }).toThrow("already bound");
});

test("close during startup shares work, prevents dispatch and releases ownership", async () => {
  const path = await directory();
  const assembly = await assembleApplication(path);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = assembly.transport.listen.bind(assembly.transport);
  const listen = spyOn(assembly.transport, "listen").mockImplementation(
    async () => {
      await held;
      await original();
    },
  );
  try {
    const starting = assembly.runtime.start();
    expect(assembly.runtime.start()).toBe(starting);
    const rejected = assert.rejects(starting, /Coordinator is stopping/u);
    const closing = assembly.runtime.close();
    expect(assembly.runtime.close()).toBe(closing);
    release();
    await rejected;
    await closing;
    expect(assembly.jobs.snapshot().scheduler).toBe("stopped");
    expect(assembly.jobs.snapshot().jobs).toEqual([]);
    const replacement = new Store(path);
    replacement.close();
    await assert.rejects(assembly.runtime.start(), /Coordinator is stopping/u);
  } finally {
    release();
    listen.mockRestore();
    await assembly.runtime.close();
    await rm(path, { recursive: true, force: true });
  }
});

test("failed startup retains a non-socket control file and releases the store", async () => {
  const path = await directory();
  const app = await createApplication(path);
  try {
    await writeFile(join(path, "run.sock"), "Retain this control path");
    await assert.rejects(app.start(), { message: /non-socket control path/u });
    expect(await readFile(join(path, "run.sock"), "utf8")).toBe(
      "Retain this control path",
    );
    const replacement = new Store(path);
    replacement.close();
    await app.close();
  } finally {
    await app.close();
    await rm(path, { recursive: true, force: true });
  }
});

test("failed job recovery closes constructed services and releases state ownership", async () => {
  const path = await directory();
  const store = new Store(path);
  const job = store.submit(
    { kind: "resolve_conflict" },
    "retained-malformed-job",
  );
  store.close();
  const db = new DatabaseSync(join(path, "jobs.sqlite"));
  db.prepare(
    "UPDATE jobs SET data=json_remove(data,'$.attempts') WHERE id=?",
  ).run(job.id);
  db.close();
  try {
    await assert.rejects(createApplication(path));
    const replacement = new Store(path);
    replacement.close();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
