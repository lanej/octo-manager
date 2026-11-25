import { toJson } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  PerformanceCaptureSchema,
  PerformanceCaptureState as State,
} from "../gen/octomanager/v2/diagnostics_pb.js";
import { schedulerClient } from "../client.js";
import { printResult } from "../cli-output.js";
import type { ParsedCommand } from "../cli/contracts.js";

export async function diagnosticsCLI(parsed: ParsedCommand): Promise<void> {
  const { values, positionals } = parsed;
  const client = schedulerClient(
    resolve(
      values.state ??
        process.env["OCTO_MANAGER_STATE"] ??
        join(homedir(), ".local", "state", "octo-manager"),
    ),
  );
  const command = positionals[0];
  let capture;
  if (command === "diagnostics-capture") {
    const seconds = values["seconds"] ?? "60";
    if (
      typeof seconds !== "string" ||
      !/^\d+$/u.test(seconds) ||
      Number(seconds) < 1 ||
      Number(seconds) > 300
    )
      throw new Error("--seconds must be an integer from 1 to 300");
    capture = (
      await client.startPerformanceCapture({
        requestId: values["request-id"] ?? randomUUID(),
        durationMs: Number(seconds) * 1000,
      })
    ).capture;
    if (values["wait"] === true) {
      while (capture?.state === State.COLLECTING) {
        await delay(500);
        capture = (await client.getPerformanceCapture({ id: capture.id }))
          .capture;
      }
    }
  } else {
    const id = positionals[1];
    if (id === undefined) throw new Error("Capture ID is required");
    capture =
      command === "diagnostics-stop"
        ? (await client.stopPerformanceCapture({ id })).capture
        : (await client.getPerformanceCapture({ id })).capture;
  }
  if (capture === undefined) throw new Error("Coordinator returned no capture");
  if (!parsed.output.full && capture.report !== undefined) {
    capture.report.queries = capture.report.queries.slice(0, 10);
    for (const query of capture.report.queries) query.stacks = [];
  }
  printResult(parsed, toJson(PerformanceCaptureSchema, capture));
  if (capture.state === State.FAILED || capture.state === State.INTERRUPTED)
    throw new Error(
      capture.detail === "" ? "Capture did not complete" : capture.detail,
    );
}
