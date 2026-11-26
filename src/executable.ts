import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

if (import.meta.main) {
  const mode = process.argv[2] ?? "";
  if (
    (mode === "--octo-internal-worker=job" || mode === "--octo-internal-worker=assessment") &&
    typeof process.send !== "function"
  )
    throw new Error("Internal worker requires an IPC parent");
  switch (mode) {
    case "--octo-internal-worker=job":
      await import("./worker.js");
      break;
    case "--octo-internal-worker=assessment":
      await import("./assessments/worker.js");
      break;
    case "--octo-internal-worker=publication":
      process.argv.splice(2, 1);
      await import("./publication/worker.js");
      break;
    default:
      await import("./cli.js");
  }
}
