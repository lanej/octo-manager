import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
export interface ImageEvidence {
  url: string;
  sha256: string;
  contentType: string;
}
export function publicImageUrl(value: string): URL {
  const url = new URL(value),
    host = url.hostname
      .replace(/\.$/u, "")
      .replace(/^\[|\]$/gu, "")
      .toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 && !publicAddress(host))
  )
    throw new Error("Inline images require public durable HTTPS URLs");
  return url;
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23]/u.test(address);
  const octets = address.split(".").map(Number),
    a = octets[0] ?? 0,
    b = octets[1] ?? 0;
  return (
    isIP(address) === 4 &&
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}
async function downloadImage(
  value: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<Omit<ImageEvidence, "url">> {
  const url = publicImageUrl(value);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  signal.throwIfAborted();
  const resolving = lookup(host, { all: true });
  const addresses = await new Promise<Awaited<typeof resolving>>(
    (resolve, reject) => {
      const cancel = () => {
        reject(new Error("Image DNS lookup cancelled or timed out"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      resolving.then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(
            error instanceof Error
              ? error
              : new Error("Image DNS lookup failed"),
          );
        },
      );
      if (signal.aborted) cancel();
    },
  );
  if (
    addresses.length === 0 ||
    addresses.some((item) => !publicAddress(item.address))
  )
    throw new Error("Inline image resolves to a non-public address");
  const first = addresses[0];
  if (first === undefined) throw new Error("Inline image has no address");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        lookup(_hostname, options, callback) {
          // Pin the checked addresses so DNS cannot change between validation and connection.
          if (options.all === true) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (
          status >= 300 &&
          status < 400 &&
          response.headers.location !== undefined
        ) {
          response.resume();
          if (redirects >= 3) {
            reject(new Error("Inline image redirect limit exceeded"));
            return;
          }
          downloadImage(
            new URL(response.headers.location, url).href,
            signal,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        if (status !== 200 || !contentType.startsWith("image/")) {
          response.resume();
          reject(new Error("Inline image is unavailable or not an image"));
          return;
        }
        const digest = createHash("sha256");
        let bytes = 0;
        response.on("data", (chunk: unknown) => {
          if (!Buffer.isBuffer(chunk)) {
            response.destroy(new Error("Invalid image response chunk"));
            return;
          }
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            response.destroy(new Error("Inline image exceeds 16 MiB"));
            return;
          }
          digest.update(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          if (bytes === 0) reject(new Error("Inline image is empty"));
          else resolve({ contentType, sha256: digest.digest("hex") });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}
export async function captureImages(
  urls: string[],
  signal: AbortSignal,
): Promise<ImageEvidence[]> {
  if (urls.length > 10)
    throw new Error("At most ten inline images are supported");
  const images: ImageEvidence[] = [];
  for (const url of new Set(urls))
    images.push({
      url,
      ...(await downloadImage(
        url,
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      )),
    });
  return images;
}
