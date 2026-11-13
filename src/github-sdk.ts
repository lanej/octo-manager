import { Octokit } from "@octokit/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface GitHubRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  headers?: Record<string, string>;
  data?: Record<string, string | boolean>;
}
export interface GitHubResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}
export type GitHubTransport = (
  request: GitHubRequest,
  signal?: AbortSignal,
  beforeSend?: () => void,
) => Promise<GitHubResponse>;
async function credential(): Promise<string> {
  try {
    const { stdout } = await exec(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 10000, maxBuffer: 16384 },
    );
    const token = stdout.trim();
    if (token === "" || /\s/u.test(token))
      throw new Error("Invalid credential");
    return token;
  } catch {
    throw new Error(
      "GitHub authentication unavailable; run gh auth login -h github.com and restart Octo",
    );
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function response(value: unknown): GitHubResponse {
  if (
    !record(value) ||
    typeof value["status"] !== "number" ||
    !record(value["headers"])
  )
    throw new Error("Invalid GitHub SDK response");
  const headers = new Map<string, string>();
  for (const [key, field] of Object.entries(value["headers"]))
    if (typeof field === "string") headers.set(key.toLowerCase(), field);
  const data: unknown = value["data"];
  const body =
    data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : typeof data === "string"
        ? data
        : JSON.stringify(data ?? null);
  if (Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("GitHub response exceeds 2 MiB");
  return { status: value["status"], headers, body };
}
async function boundedFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  fetcher: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response>,
): Promise<Response> {
  const result = await fetcher(input, init);
  if (result.body === null) return result;
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("GitHub response exceeds 2 MiB");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}
export function sdkTransport(
  auth: () => Promise<string> = credential,
  fetcher: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): GitHubTransport {
  let client: Promise<Octokit> | undefined;
  return async (request, signal, beforeSend) => {
    signal?.throwIfAborted();
    if (/^\w+:|^\/\/|[\\\r\n#]/u.test(request.path))
      throw new Error("GitHub request must use an API-relative path");
    client ??= auth().then(
      (token) =>
        new Octokit({
          auth: token,
          userAgent: "octo-manager",
          request: {
            fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
              boundedFetch(input, init, fetcher),
          },
        }),
    );
    const octokit = await client;
    signal?.throwIfAborted();
    beforeSend?.();
    try {
      return response(
        await octokit.request({
          method: request.method,
          url: "/" + request.path.replace(/^\//u, ""),
          ...(request.headers === undefined
            ? {}
            : { headers: request.headers }),
          ...(request.data === undefined ? {} : { data: request.data }),
          request: {
            signal:
              signal === undefined
                ? AbortSignal.timeout(20000)
                : AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          },
        }),
      );
    } catch (error) {
      if (record(error) && record(error["response"]))
        return response(error["response"]);
      throw new Error(
        signal?.aborted === true
          ? "GitHub request cancelled"
          : "GitHub unavailable; check authentication, access and connectivity",
      );
    }
  };
}
