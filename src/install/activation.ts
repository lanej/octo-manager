import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeLifecycle } from "../lifecycle-rpc.js";
import { schedulerClient } from "../client.js";
import type { ActivationProcess } from "../lifecycle.js";
import type {
  ServiceDefinition,
  ServiceInput,
  ServiceRunner,
} from "./service.js";

/** The installer stops only a confirmed, exact native owner incarnation. */
export class IncompleteActivation extends Error {}

export interface CheckpointBinding {
  process: ActivationProcess;
  runID: string;
  runningIdentity: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processIdentity(value: unknown): value is ActivationProcess {
  return (
    object(value) &&
    typeof value["pid"] === "number" &&
    Number.isSafeInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["start_identity"] === "string" &&
    value["start_identity"] !== "" &&
    typeof value["native_id"] === "string" &&
    value["native_id"] !== "" &&
    value["owner_verified"] === true
  );
}

function sameProcess(
  first: ActivationProcess,
  second: ActivationProcess,
): boolean {
  return (
    first.pid === second.pid &&
    first.start_identity === second.start_identity &&
    first.native_id === second.native_id &&
    first.owner_verified === second.owner_verified
  );
}

function missing(error: unknown): boolean {
  return object(error) && error["code"] === "ENOENT";
}

/** Frozen inventory contains no credentials and is read without following links. */
export async function readCheckpointBinding(
  environment: NodeJS.ProcessEnv,
): Promise<CheckpointBinding | undefined> {
  const directory = environment["PROJECT_UPDATE_OPERATION_DIR"],
    runID = environment["PROJECT_UPDATE_RUN_ID"];
  if (directory === undefined && runID === undefined) return undefined;
  if (
    directory === undefined ||
    runID === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      runID,
    )
  )
    throw new IncompleteActivation(
      "native-checkpoint-operation-binding-unavailable",
    );
  const file = await open(
    join(directory, "octo-manager-inventory.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new IncompleteActivation("native-checkpoint-inventory-unavailable");
  });
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024 * 1024
    )
      throw new IncompleteActivation(
        "native-checkpoint-inventory-is-not-private-and-owned",
      );
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new IncompleteActivation("native-checkpoint-inventory-is-invalid");
    }
    if (
      !object(value) ||
      value["schema_version"] !== 1 ||
      !Array.isArray(value["targets"]) ||
      value["targets"].length !== 1
    )
      throw new IncompleteActivation("native-checkpoint-inventory-is-invalid");
    const target: unknown = value["targets"][0];
    if (
      !object(target) ||
      !processIdentity(target["process"]) ||
      typeof target["running_identity"] !== "string" ||
      target["running_identity"] === ""
    )
      throw new IncompleteActivation(
        "native-checkpoint-process-or-image-is-unavailable",
      );
    return {
      process: target["process"],
      runID,
      runningIdentity: target["running_identity"],
    };
  } finally {
    await file.close();
  }
}

function managerPID(
  definition: ServiceDefinition,
  run: ServiceRunner,
): number | null {
  if (definition.kind === "launchd") {
    let output: string;
    try {
      output = run("/bin/launchctl", ["print", definition.target]);
    } catch (error) {
      if (object(error) && (error["status"] === 3 || error["status"] === 113))
        return null;
      throw new IncompleteActivation(
        "native-service-manager-inspection-unavailable",
      );
    }
    const match = /\bpid = ([1-9][0-9]*)\b/u.exec(output);
    if (match?.[1] === undefined)
      throw new IncompleteActivation(
        "native-service-process-identity-unavailable",
      );
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid))
      throw new IncompleteActivation("native-service-process-identity-invalid");
    return pid;
  }
  let output: string;
  try {
    output = run("systemctl", [
      "--user",
      "show",
      definition.target,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=MainPID",
    ]);
  } catch {
    throw new IncompleteActivation(
      "native-service-manager-inspection-unavailable",
    );
  }
  const values = new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (
    (values.get("LoadState") === "not-found" ||
      values.get("LoadState") === "loaded") &&
    values.get("ActiveState") === "inactive" &&
    values.get("MainPID") === "0"
  )
    return null;
  const pid = Number(values.get("MainPID"));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new IncompleteActivation(
      "native-service-process-identity-unavailable",
    );
  return pid;
}

async function ownedSocket(state: string): Promise<boolean> {
  try {
    const info = await lstat(join(state, "run.sock"));
    if (
      !info.isSocket() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new IncompleteActivation(
        "native-owner-socket-is-not-private-and-owned",
      );
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function coldOwnerAbsent(state: string): Promise<void> {
  const path = join(state, "coordinator-lock.sqlite");
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new IncompleteActivation(
        "native-owner-lock-is-not-private-and-owned",
      );
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK");
  } catch {
    throw new IncompleteActivation(
      "native-owner-remains-present-without-checkpoint-control",
    );
  } finally {
    lock.close();
  }
}

/** Native RPC plus service-manager PID bind replacement independently of adapters. */
export async function guardServiceReplacement(
  definition: ServiceDefinition,
  input: ServiceInput,
  run: ServiceRunner,
  binding?: CheckpointBinding,
): Promise<"cold" | "checkpointed"> {
  const pid = managerPID(definition, run),
    socket = await ownedSocket(input.state);
  if (pid === null && !socket && binding === undefined) {
    await coldOwnerAbsent(input.state);
    return "cold";
  }
  if (pid === null || !socket || binding === undefined)
    throw new IncompleteActivation(
      "native-service-checkpoint-binding-required",
    );
  let value: unknown;
  try {
    const response = await runtimeLifecycle(input.state, {
      action: "inventory",
    });
    value = response;
  } catch {
    throw new IncompleteActivation(
      "native-service-checkpoint-control-unavailable",
    );
  }
  if (
    !object(value) ||
    value["schema_version"] !== 1 ||
    !Array.isArray(value["targets"]) ||
    value["targets"].length !== 1
  )
    throw new IncompleteActivation("native-service-checkpoint-report-invalid");
  const target: unknown = value["targets"][0];
  if (
    !object(target) ||
    !processIdentity(target["process"]) ||
    !sameProcess(target["process"], binding.process) ||
    target["process"].pid !== pid ||
    target["running_identity"] !== binding.runningIdentity ||
    !object(target["checkpoint"]) ||
    target["checkpoint"]["state"] !== "confirmed" ||
    target["checkpoint"]["run_id"] !== binding.runID
  )
    throw new IncompleteActivation(
      "native-service-checkpoint-or-process-incarnation-differs",
    );
  if (target["retirement_policy"] !== "successful-exit")
    throw new IncompleteActivation(
      "native-successful-exit-retirement-policy-unavailable",
    );
  return "checkpointed";
}

/** Global clients remain unchanged until their native owner can be replaced safely. */
export async function guardClientPromotion(
  definition: ServiceDefinition,
  input: ServiceInput,
  run: ServiceRunner,
  available: boolean,
  binding?: CheckpointBinding,
): Promise<void> {
  const socket = await ownedSocket(input.state);
  if (socket) {
    try {
      const server = await schedulerClient(input.state).getServerInfo(
        {},
        { timeoutMs: 1000 },
      );
      if (server.apiVersion !== 2) throw new Error("Incompatible native API");
    } catch {
      throw new IncompleteActivation(
        "native-client-promotion-api-incompatible-or-unavailable",
      );
    }
    if (!available)
      throw new IncompleteActivation(
        "native-client-promotion-manager-binding-unavailable",
      );
  }
  if (available) await guardServiceReplacement(definition, input, run, binding);
  else await coldOwnerAbsent(input.state);
}

// Kernel process absence and a stopped manager job must both precede any OS
// service stop. No signal, forced termination, or stop timeout is used here.
export async function retireService(
  definition: ServiceDefinition,
  input: ServiceInput,
  run: ServiceRunner,
  binding: CheckpointBinding,
): Promise<void> {
  await guardServiceReplacement(definition, input, run, binding);
  let value: unknown;
  try {
    const response = await runtimeLifecycle(input.state, {
      action: "stop",
      expectedNativeId: binding.process.native_id,
      runId: binding.runID,
      expectedIdentity: binding.runningIdentity,
    });
    value = response;
  } catch {
    throw new IncompleteActivation("native-stop-outcome-unconfirmed");
  }
  if (
    !object(value) ||
    value["schema_version"] !== 1 ||
    !Array.isArray(value["targets"]) ||
    value["targets"].length !== 1
  )
    throw new IncompleteActivation("native-stop-report-invalid");
  const target: unknown = value["targets"][0];
  if (
    !object(target) ||
    !processIdentity(target["process"]) ||
    !sameProcess(target["process"], binding.process) ||
    target["stop_accepted"] !== true ||
    target["retirement_policy"] !== "successful-exit"
  )
    throw new IncompleteActivation("native-stop-process-or-acceptance-differs");
  const deadline = Date.now() + 60000;
  for (;;) {
    let alive = true;
    try {
      process.kill(binding.process.pid, 0);
    } catch (error) {
      if (object(error) && error["code"] === "ESRCH") alive = false;
      else
        throw new IncompleteActivation(
          "native-retired-process-identity-unavailable",
        );
    }
    let managerGone = false;
    if (definition.kind === "launchd") {
      try {
        const output = run("/bin/launchctl", ["print", definition.target]);
        const match = /\bpid = ([1-9][0-9]*)\b/u.exec(output);
        if (match?.[1] === undefined) {
          if (!/\bstate = /u.test(output))
            throw new IncompleteActivation(
              "native-retired-manager-state-unavailable",
            );
          managerGone = true;
        } else if (Number(match[1]) !== binding.process.pid)
          throw new IncompleteActivation(
            "native-service-respawned-before-retirement",
          );
      } catch (error) {
        if (object(error) && (error["status"] === 3 || error["status"] === 113))
          managerGone = true;
        else throw error;
      }
    } else {
      const output = run("systemctl", [
        "--user",
        "show",
        definition.target,
        "--property=ActiveState",
        "--property=MainPID",
      ]);
      const pid = /^MainPID=([0-9]+)$/mu.exec(output)?.[1];
      if (
        pid !== undefined &&
        Number(pid) !== 0 &&
        Number(pid) !== binding.process.pid
      )
        throw new IncompleteActivation(
          "native-service-respawned-before-retirement",
        );
      managerGone = pid === "0" && /^ActiveState=inactive$/mu.test(output);
    }
    if (!alive && managerGone) {
      await coldOwnerAbsent(input.state);
      return;
    }
    if (Date.now() >= deadline)
      throw new IncompleteActivation(
        "native-retirement-deadline-process-preserved",
      );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** Recheck immediately before OS control; any newly present owner is preserved. */
export function confirmRetiredService(
  definition: ServiceDefinition,
  run: ServiceRunner,
  binding: CheckpointBinding,
): void {
  try {
    process.kill(binding.process.pid, 0);
    throw new IncompleteActivation("native-retired-owner-remains-present");
  } catch (error) {
    if (!object(error) || error["code"] !== "ESRCH") throw error;
  }
  if (definition.kind === "launchd") {
    try {
      const output = run("/bin/launchctl", ["print", definition.target]);
      if (/\bpid = [1-9][0-9]*\b/u.test(output) || !/\bstate = /u.test(output))
        throw new IncompleteActivation(
          "native-owner-appeared-before-service-control",
        );
    } catch (error) {
      if (!object(error) || (error["status"] !== 3 && error["status"] !== 113))
        throw error;
    }
  } else {
    const output = run("systemctl", [
      "--user",
      "show",
      definition.target,
      "--property=ActiveState",
      "--property=MainPID",
    ]);
    if (
      !/^MainPID=0$/mu.test(output) ||
      !/^ActiveState=inactive$/mu.test(output)
    )
      throw new IncompleteActivation(
        "native-owner-appeared-before-service-control",
      );
  }
}

/** Freeze the owner-selected immutable bundle and host identity before stopping. */
export function selectedServiceIdentity(
  input: ServiceInput,
  run: ServiceRunner,
): string {
  let value: unknown;
  try {
    value = JSON.parse(
      run("/usr/bin/env", [
        "PATH=" + input.path,
        "bun",
        join(input.release, "dist/cli.js"),
        "lifecycle",
        "artifact",
      ]),
    );
  } catch {
    throw new IncompleteActivation(
      "native-selected-artifact-inspection-unavailable",
    );
  }
  if (
    !object(value) ||
    typeof value["expected_identity"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value["expected_identity"])
  )
    throw new IncompleteActivation(
      "native-selected-artifact-identity-unavailable",
    );
  return value["expected_identity"];
}

/** Inspect only; a failed proof must never submit another launch or termination. */
export async function verifyStartedService(
  definition: ServiceDefinition,
  input: ServiceInput,
  run: ServiceRunner,
  expectedIdentity: string,
  original?: CheckpointBinding,
): Promise<void> {
  const deadline = Date.now() + 60000;
  for (;;) {
    let pid: number | null = null;
    let value: unknown;
    try {
      pid = managerPID(definition, run);
      if (pid !== null && (await ownedSocket(input.state))) {
        const response = await runtimeLifecycle(
          input.state,
          { action: "inventory" },
          Math.max(1, Math.min(1000, deadline - Date.now())),
        );
        value = response;
      }
    } catch (error) {
      if (
        error instanceof IncompleteActivation &&
        error.message === "native-owner-socket-is-not-private-and-owned"
      )
        throw error;
    }
    if (value !== undefined) {
      if (
        !object(value) ||
        value["schema_version"] !== 1 ||
        !Array.isArray(value["targets"]) ||
        value["targets"].length !== 1
      )
        throw new IncompleteActivation("native-started-service-report-invalid");
      const target: unknown = value["targets"][0];
      if (
        !object(target) ||
        !processIdentity(target["process"]) ||
        target["process"].pid !== pid ||
        target["running_identity"] !== expectedIdentity ||
        target["expected_identity"] !== expectedIdentity ||
        target["retirement_policy"] !== "successful-exit" ||
        target["stop_accepted"] !== false ||
        (original !== undefined &&
          sameProcess(target["process"], original.process))
      )
        throw new IncompleteActivation(
          "native-started-service-image-or-process-differs",
        );
      if (target["ready"] === true) {
        if (managerPID(definition, run) !== target["process"].pid)
          throw new IncompleteActivation(
            "native-started-service-manager-owner-changed",
          );
        return;
      }
    }
    if (Date.now() >= deadline)
      throw new IncompleteActivation(
        "native-started-service-readiness-unconfirmed",
      );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}
