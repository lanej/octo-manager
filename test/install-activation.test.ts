import type { ActivationTarget } from "../src/lifecycle.js";
import { wireLifecycle } from "../src/lifecycle-rpc.js";
import { LifecycleAction } from "../src/gen/octomanager/v2/lifecycle_pb.js";
import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SchedulerService } from "../src/gen/octomanager/v2/scheduler_pb.js";
import {
  guardServiceReplacement,
  guardClientPromotion,
  readCheckpointBinding,
  IncompleteActivation,
  verifyStartedService,
  selectedServiceIdentity,
  type CheckpointBinding,
} from "../src/install/activation.js";
import { serviceDefinition, type ServiceInput } from "../src/install/service.js";

function input(state: string): ServiceInput {
  return {
    home: state,
    release: "/fixture/release",
    state,
    path: "/usr/bin",
    configHome: state,
    codexHome: state,
  };
}
test.each(["not-found", "loaded"])(
  "installer refuses an owner lock with %s inactive zero-PID unit",
  async (loadState) => {
    const directory = await mkdtemp("/tmp/octo-install-lock-");
    const lockPath = join(directory, "coordinator-lock.sqlite"),
      lock = new DatabaseSync(lockPath);
    await chmod(lockPath, 0o600);
    lock.exec("BEGIN EXCLUSIVE");
    try {
      await assert.rejects(
        guardServiceReplacement(
          serviceDefinition("linux", input(directory), 1000),
          input(directory),
          () => `LoadState=${loadState}\nActiveState=inactive\nMainPID=0\n`,
        ),
        /native-owner-remains-present-without-checkpoint-control/u,
      );
    } finally {
      lock.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("stopped installed unit requires a private available owner lock", async () => {
  const directory = await mkdtemp("/tmp/octo-install-cold-lock-"),
    selected = input(directory),
    definition = serviceDefinition("linux", selected, 1000),
    lockPath = join(directory, "coordinator-lock.sqlite"),
    lock = new DatabaseSync(lockPath),
    manager = () => "LoadState=loaded\nActiveState=inactive\nMainPID=0\n";
  lock.close();
  await chmod(lockPath, 0o600);
  try {
    expect(await guardServiceReplacement(definition, selected, manager)).toBe("cold");
    await guardClientPromotion(definition, selected, manager, true);
    await chmod(lockPath, 0o644);
    await assert.rejects(
      guardServiceReplacement(definition, selected, manager),
      /native-owner-lock-is-not-private-and-owned/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopped installed unit preserves native socket ownership checks", async () => {
  const directory = await mkdtemp("/tmp/octo-install-cold-socket-"),
    selected = input(directory),
    definition = serviceDefinition("linux", selected, 1000),
    socket = join(directory, "run.sock"),
    server = createServer(),
    manager = () => "LoadState=loaded\nActiveState=inactive\nMainPID=0\n";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socket, 0o600);
  try {
    await assert.rejects(
      guardServiceReplacement(definition, selected, manager),
      /native-service-checkpoint-binding-required/u,
    );
    await chmod(socket, 0o644);
    await assert.rejects(
      guardServiceReplacement(definition, selected, manager),
      /native-owner-socket-is-not-private-and-owned/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "LoadState=loaded\nActiveState=active\nMainPID=0\n",
  "LoadState=loaded\nActiveState=activating\nMainPID=0\n",
  "LoadState=loaded\nActiveState=inactive\nMainPID=42\n",
  "LoadState=masked\nActiveState=inactive\nMainPID=0\n",
  "LoadState=loaded\nMainPID=0\n",
])("installer refuses a non-cold manager report: %s", async (report) => {
  const directory = await mkdtemp("/tmp/octo-install-cold-state-");
  try {
    await assert.rejects(
      guardServiceReplacement(serviceDefinition("linux", input(directory), 1000), input(directory), () => report),
      IncompleteActivation,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer binds a confirmed checkpoint to real native RPC, run UUID and manager PID", async () => {
  const directory = await mkdtemp("/tmp/octo-install-rpc-");
  const selectedInput = input(directory),
    definition = serviceDefinition("linux", selectedInput, 1000);
  const binding: CheckpointBinding = {
    runID: "11111111-2222-4333-8444-555555555555",
    runningIdentity: "managed-original-image",
    process: {
      pid: process.pid,
      start_identity: "native-kernel-start",
      native_id: "native-incarnation",
      owner_verified: true,
    },
  };
  let target: ActivationTarget = {
    target: "local",
    expected_identity: binding.runningIdentity,
    running_identity: binding.runningIdentity,
    ready: false,
    process: binding.process,
    sessions: [],
    scheduler_paused: true,
    retirement_policy: "successful-exit",
    stop_accepted: false,
    checkpoint: { state: "confirmed", run_id: binding.runID },
  };
  let inspections = 0;
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(SchedulerService, {
          getServerInfo() {
            return { apiVersion: 2 };
          },
          runtimeLifecycle(request) {
            if (request.action !== LifecycleAction.INVENTORY) throw new Error("guard attempted native mutation");
            inspections++;
            return {
              report: wireLifecycle({
                schema_version: 1,
                targets: [target],
              }),
            };
          },
        });
      },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(directory, "run.sock"), () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(join(directory, "run.sock"), 0o600);
  const manager = () => `LoadState=loaded\nActiveState=active\nMainPID=${String(process.pid)}\n`;
  try {
    await assert.rejects(guardServiceReplacement(definition, selectedInput, manager), IncompleteActivation);
    expect(await guardServiceReplacement(definition, selectedInput, manager, binding)).toBe("checkpointed");
    await assert.rejects(guardClientPromotion(definition, selectedInput, manager, true), IncompleteActivation);
    await guardClientPromotion(definition, selectedInput, manager, true, binding);
    target = {
      ...target,
      process: { ...binding.process, native_id: "different-owner" },
    };
    await assert.rejects(
      guardServiceReplacement(definition, selectedInput, manager, binding),
      /native-service-checkpoint-or-process-incarnation-differs/u,
    );
    target = {
      ...target,
      process: binding.process,
      checkpoint: { state: "refused", run_id: binding.runID },
    };
    await assert.rejects(
      guardServiceReplacement(definition, selectedInput, manager, binding),
      /native-service-checkpoint-or-process-incarnation-differs/u,
    );
    await assert.rejects(
      guardClientPromotion(definition, selectedInput, manager, true, binding),
      /native-service-checkpoint-or-process-incarnation-differs/u,
    );
    target = {
      ...target,
      checkpoint: {
        state: "confirmed",
        run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
    };
    await assert.rejects(
      guardServiceReplacement(definition, selectedInput, manager, binding),
      /native-service-checkpoint-or-process-incarnation-differs/u,
    );
    target = {
      ...target,
      checkpoint: { state: "confirmed", run_id: binding.runID },
    };
    await assert.rejects(
      guardServiceReplacement(
        definition,
        selectedInput,
        () => `LoadState=loaded\nActiveState=active\nMainPID=${String(process.pid + 1)}\n`,
        binding,
      ),
      /native-service-checkpoint-or-process-incarnation-differs/u,
    );
    expect(inspections).toBe(7);
    expect(() => selectedServiceIdentity(selectedInput, () => JSON.stringify({ expected_identity: null }))).toThrow(
      IncompleteActivation,
    );
    expect(selectedServiceIdentity(selectedInput, () => JSON.stringify({ expected_identity: "a".repeat(64) }))).toBe(
      "a".repeat(64),
    );
    target = {
      ...target,
      ready: true,
      expected_identity: "new-selected-image",
      running_identity: "new-selected-image",
      process: { ...binding.process, native_id: "new-native-owner" },
    };
    await verifyStartedService(definition, selectedInput, manager, "new-selected-image", binding);
    await assert.rejects(
      verifyStartedService(definition, selectedInput, manager, "different-selected-image", binding),
      /native-started-service-image-or-process-differs/u,
    );
    target = { ...target, process: binding.process };
    await assert.rejects(
      verifyStartedService(definition, selectedInput, manager, "new-selected-image", binding),
      /native-started-service-image-or-process-differs/u,
    );
    target = {
      ...target,
      process: { ...binding.process, native_id: "new-native-owner" },
    };
    let managerReads = 0;
    await assert.rejects(
      verifyStartedService(
        definition,
        selectedInput,
        () => {
          managerReads++;
          return `LoadState=loaded\nActiveState=active\nMainPID=${String(process.pid + (managerReads > 1 ? 1 : 0))}\n`;
        },
        "new-selected-image",
        binding,
      ),
      /native-started-service-manager-owner-changed/u,
    );
    target = {
      ...target,
      expected_identity: binding.runningIdentity,
      running_identity: binding.runningIdentity,
      process: binding.process,
    };
    const inventory = join(directory, "octo-manager-inventory.json");
    await writeFile(inventory, JSON.stringify({ schema_version: 1, targets: [target] }), { mode: 0o600 });
    expect(
      await readCheckpointBinding({
        PROJECT_UPDATE_OPERATION_DIR: directory,
        PROJECT_UPDATE_RUN_ID: binding.runID,
      }),
    ).toEqual(binding);
    await chmod(inventory, 0o644);
    await assert.rejects(
      readCheckpointBinding({
        PROJECT_UPDATE_OPERATION_DIR: directory,
        PROJECT_UPDATE_RUN_ID: binding.runID,
      }),
      /native-checkpoint-inventory-is-not-private-and-owned/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
});
