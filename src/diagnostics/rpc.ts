import { Code, ConnectError } from "@connectrpc/connect";
import type {
  StartPerformanceCaptureRequest,
  GetPerformanceCaptureRequest,
  StopPerformanceCaptureRequest,
} from "../gen/octomanager/v2/diagnostics_pb.js";
import { CaptureError, type PerformanceDiagnostics } from "./service.js";

function operation<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CaptureError) {
      const codes = {
        invalid: Code.InvalidArgument,
        conflict: Code.AlreadyExists,
        unsupported: Code.FailedPrecondition,
        missing: Code.NotFound,
        storage: Code.Internal,
      };
      throw new ConnectError(error.message, codes[error.kind]);
    }
    throw new ConnectError("Performance capture failed", Code.Internal);
  }
}

export function diagnosticsRoutes(diagnostics: PerformanceDiagnostics) {
  return {
    startPerformanceCapture: (r: StartPerformanceCaptureRequest) =>
      operation(() => ({
        capture: diagnostics.start(r.requestId, r.durationMs),
      })),
    getPerformanceCapture: (r: GetPerformanceCaptureRequest) => operation(() => ({ capture: diagnostics.get(r.id) })),
    stopPerformanceCapture: (r: StopPerformanceCaptureRequest) =>
      operation(() => ({ capture: diagnostics.stop(r.id) })),
  };
}
