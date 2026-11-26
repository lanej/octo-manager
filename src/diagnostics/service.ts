import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import {
  PerformanceCaptureSchema,
  PerformanceCaptureState as State,
  type PerformanceCapture,
} from "../gen/octomanager/v2/diagnostics_pb.js";
import { Recorder, queryEventsSupported } from "./recorder.js";

const maximumFileBytes = 8 * 1024 * 1024;
export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "conflict" | "unsupported" | "missing" | "storage",
  ) {
    super(message);
  }
}
export class PerformanceDiagnostics {
  private active: { capture: PerformanceCapture; recorder: Recorder; timer: NodeJS.Timeout } | undefined;
  private last: PerformanceCapture | undefined;
  private root: string;
  constructor(
    directory: string,
    private supported = queryEventsSupported,
  ) {
    this.root = resolve(directory, "diagnostics", "performance");
  }
  private file(id: string): string {
    if (!/^[a-f0-9]{32}$/u.test(id)) throw new CaptureError("Invalid capture ID", "invalid");
    return join(this.root, id + ".json");
  }
  private secureDirectories(): void {
    for (const path of [resolve(this.root, ".."), this.root]) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("Unsafe diagnostics directory");
    }
  }
  private save(capture: PerformanceCapture, initial = false): void {
    const data = toJsonString(PerformanceCaptureSchema, capture);
    if (Buffer.byteLength(data) > maximumFileBytes) throw new Error("Capture exceeds artifact bound");
    const file = this.file(capture.id);
    if (initial) {
      writeFileSync(file, data, { mode: 0o600, flag: "wx" });
      return;
    }
    const partial = file + "." + randomUUID() + ".partial";
    try {
      writeFileSync(partial, data, { mode: 0o600, flag: "wx" });
      renameSync(partial, file);
    } finally {
      try {
        unlinkSync(partial);
      } catch {
        /* rename consumes the temporary file */
      }
    }
  }
  start(requestId: string, durationMs: number): PerformanceCapture {
    if (
      requestId.length === 0 ||
      requestId.length > 200 ||
      !Number.isInteger(durationMs) ||
      durationMs < 1000 ||
      durationMs > 300000
    )
      throw new CaptureError(
        "Capture requires a request ID of 1–200 characters and duration of 1000–300000 ms",
        "invalid",
      );
    const id = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
    try {
      const existing = this.get(id);
      if (existing.requestId !== requestId || existing.durationMs !== durationMs)
        throw new CaptureError("Capture request ID already used with different options", "conflict");
      return existing;
    } catch (error) {
      if (!(error instanceof CaptureError && error.kind === "missing")) throw error;
    }
    if (this.active !== undefined)
      throw new CaptureError("Capture already active: " + this.active.capture.id, "conflict");
    if (!this.supported())
      throw new CaptureError(
        "Runtime does not publish sqlite.db.query events; install a supported native build",
        "unsupported",
      );
    const capture = create(PerformanceCaptureSchema, {
      id,
      requestId,
      state: State.COLLECTING,
      startedAtMs: BigInt(Date.now()),
      durationMs,
      artifactPath: this.file(id),
    });
    try {
      this.secureDirectories();
      this.save(capture, true);
    } catch {
      throw new CaptureError("Cannot create private diagnostics artifact", "storage");
    }
    try {
      const recorder = new Recorder(resolve(this.root, "../.."));
      const timer = setTimeout(() => {
        this.finish(State.COMPLETED);
      }, durationMs);
      timer.unref();
      this.active = { capture, recorder, timer };
      return capture;
    } catch {
      capture.state = State.FAILED;
      capture.detail = "Recorder could not start";
      capture.endedAtMs = BigInt(Date.now());
      this.last = capture;
      try {
        this.save(capture);
      } catch {
        capture.detail = "Recorder could not start; terminal artifact write failed";
      }
      return capture;
    }
  }
  get(id: string): PerformanceCapture {
    const file = this.file(id);
    if (this.active?.capture.id === id) return this.active.capture;
    if (this.last?.id === id) return this.last;
    let fd: number | undefined;
    try {
      // Do not follow a substituted artifact or accept a FIFO/device as a report.
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > maximumFileBytes
      )
        throw new Error("Unsafe artifact");
      const capture = fromJsonString(PerformanceCaptureSchema, readFileSync(fd, "utf8"));
      if (
        capture.id !== id ||
        capture.artifactPath !== file ||
        capture.durationMs < 1000 ||
        capture.durationMs > 300000 ||
        capture.state === State.UNSPECIFIED
      )
        throw new Error("Invalid artifact");
      if (capture.state === State.COLLECTING) {
        capture.state = State.INTERRUPTED;
        capture.detail = "Owning recorder is no longer running; no terminal report was saved";
      }
      return capture;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new CaptureError("Capture not found", "missing");
      throw new CaptureError("Cannot read a valid private capture artifact", "storage");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  stop(id: string): PerformanceCapture {
    this.file(id);
    return this.active?.capture.id === id ? this.finish(State.STOPPED) : this.get(id);
  }
  private finish(state: State): PerformanceCapture {
    const active = this.active;
    if (active === undefined) throw new Error("No active capture");
    clearTimeout(active.timer);
    active.capture.report = active.recorder.stop();
    active.capture.endedAtMs = BigInt(Date.now());
    active.capture.state = state;
    this.active = undefined;
    this.last = active.capture;
    try {
      this.save(active.capture);
    } catch {
      active.capture.state = State.FAILED;
      active.capture.detail = "Terminal artifact write failed; report retained only until the next capture or restart";
    }
    return active.capture;
  }
  close(): void {
    if (this.active !== undefined) this.finish(State.STOPPED);
  }
}
