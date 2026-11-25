import "../src/executable.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createWorkerRuntime } from "../src/jobs/auth.js";
import { join } from "node:path";

let networkAttempts = 0;
let sdkSendAttempts = 0;
Object.defineProperty(BedrockRuntimeClient.prototype, "send", {
  value: () => {
    sdkSendAttempts++;
    return Promise.reject(
      new Error("Native provider probe forbids SDK transport"),
    );
  },
});
Object.defineProperty(globalThis, "fetch", {
  value: () => {
    networkAttempts++;
    return Promise.reject(new Error("Native provider probe forbids network"));
  },
});
const home = process.argv[2];
if (home === undefined)
  throw new Error("Pass the private synthetic credential home");
const provider = process.argv[3] ?? "openai-codex";
if (provider !== "openai-codex" && provider !== "amazon-bedrock")
  throw new Error("Unsupported native provider probe");
const { runtime, source } = await createWorkerRuntime({
  provider,
  piAgentDir: join(home, "pi"),
  codexHome: join(home, "codex"),
});
const model =
  provider === "openai-codex"
    ? runtime.getModel(provider, "gpt-6.1-terra")
    : runtime.getModels(provider)[0];
if (model === undefined) throw new Error("Supported worker model unavailable");
const auth = await runtime.getAuth(model);
if (
  source !== (provider === "amazon-bedrock" ? "aws" : "codex") ||
  auth === undefined
)
  throw new Error("Synthetic provider authentication did not resolve");
let providerInitialized = false;
const sentinel = "native-provider-probe-stopped-before-transport";
const response = await runtime
  .stream(
    model,
    { messages: [] },
    {
      transport: "sse",
      onPayload() {
        providerInitialized = true;
        throw new Error(sentinel);
      },
    },
  )
  .result();
if (
  response.errorMessage?.includes(sentinel) !== true ||
  networkAttempts !== 0 ||
  sdkSendAttempts !== 0
)
  throw new Error(
    `Provider initialization did not stop before transport: ${response.errorMessage ?? "missing result"}; network attempts=${String(networkAttempts)}; SDK send attempts=${String(sdkSendAttempts)}`,
  );
console.log(
  JSON.stringify({
    provider,
    authResolved: true,
    providerInitialized,
    networkAttempts,
    sdkSendAttempts,
  }),
);
