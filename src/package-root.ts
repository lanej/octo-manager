import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const OCTO_NATIVE_AOT: boolean;
export const nativeAot = typeof OCTO_NATIVE_AOT !== "undefined" && OCTO_NATIVE_AOT;
export function packageRoot(): string {
  return nativeAot ? dirname(dirname(process.execPath)) : dirname(dirname(fileURLToPath(import.meta.url)));
}
export type WorkerKind = "job" | "assessment" | "publication";
export function workerModule(kind: WorkerKind, moduleUrl: string): string {
  return nativeAot ? `--octo-internal-worker=${kind}` : fileURLToPath(moduleUrl);
}
export function releaseModule(moduleUrl: string): string {
  return nativeAot ? pathToFileURL(join(packageRoot(), "dist/startup-context.js")).href : moduleUrl;
}
