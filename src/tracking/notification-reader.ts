import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalPR } from "./github.js";
const exec = promisify(execFile);
export interface NotificationUpdate {
  id: string;
  updatedAt: number;
  prUrl?: string;
}
export interface NotificationPage {
  updates: NotificationUpdate[];
  more: boolean;
  notModified: boolean;
  pollSeconds: number;
  lastModified?: string;
  serverTime?: number;
}
export interface NotificationQuery {
  since: number;
  page: number;
  lastModified?: string;
}
export interface NotificationReader {
  identity(signal: AbortSignal): Promise<string>;
  page(
    query: NotificationQuery,
    signal: AbortSignal,
  ): Promise<NotificationPage>;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export class NotificationAccessError extends Error {
  constructor(readonly retryAt: number | undefined) {
    super(
      "GitHub notification access unavailable; check authentication, rate limits and connectivity",
    );
  }
}
function header(stdout: string, name: string): string | undefined {
  return stdout
    .split(/\r?\n\r?\n/u)[0]
    ?.split(/\r?\n/u)
    .find((line) => line.toLowerCase().startsWith(name + ":"))
    ?.slice(name.length + 1)
    .trim();
}
export function notificationAccessError(
  stdout: string,
): NotificationAccessError {
  const date = Date.parse(header(stdout, "date") ?? ""),
    now = Number.isFinite(date) ? date : Date.now();
  const after = header(stdout, "retry-after"),
    numeric = Number(after),
    reset = Number(header(stdout, "x-ratelimit-reset"));
  const candidates: number[] = [];
  if (after !== undefined) {
    const at = Number.isFinite(numeric)
      ? now + numeric * 1000
      : Date.parse(after);
    if (Number.isSafeInteger(at)) candidates.push(at);
  }
  if (header(stdout, "x-ratelimit-remaining") === "0" && Number.isFinite(reset))
    candidates.push(reset * 1000 + 1000);
  return new NotificationAccessError(
    candidates.length === 0 ? undefined : Math.max(...candidates),
  );
}
async function request(args: string[], signal: AbortSignal): Promise<string> {
  try {
    return (
      await exec("gh", args, {
        signal,
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    throw notificationAccessError(
      record(error) && typeof error["stdout"] === "string"
        ? error["stdout"]
        : "",
    );
  }
}
export function parseNotification(value: unknown): NotificationUpdate {
  if (
    !record(value) ||
    typeof value["id"] !== "string" ||
    typeof value["updated_at"] !== "string"
  )
    throw new Error("Invalid GitHub notification");
  const updatedAt = Date.parse(value["updated_at"]);
  if (!Number.isSafeInteger(updatedAt))
    throw new Error("Invalid notification timestamp");
  const result: NotificationUpdate = { id: value["id"], updatedAt };
  const subject = value["subject"];
  if (
    record(subject) &&
    subject["type"] === "PullRequest" &&
    typeof subject["url"] === "string"
  ) {
    const match =
      /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)$/u.exec(
        subject["url"],
      );
    if (match !== null)
      result.prUrl = canonicalPR(
        `https://github.com/${match[1] ?? ""}/${match[2] ?? ""}/pull/${match[3] ?? ""}`,
      );
  }
  return result;
}
export function parseNotificationResponse(stdout: string): NotificationPage {
  const split = stdout.search(/\r?\n\r?\n/u);
  if (split < 0) throw new Error("Missing GitHub response headers");
  const headers = stdout.slice(0, split),
    body = stdout.slice(split).trim();
  const field = (name: string) =>
    headers
      .split(/\r?\n/u)
      .find((line) => line.toLowerCase().startsWith(name + ":"))
      ?.slice(name.length + 1)
      .trim();
  const interval = Number(field("x-poll-interval") ?? 60);
  if (!Number.isFinite(interval) || interval < 0)
    throw new Error("Invalid GitHub polling interval");
  const result: NotificationPage = {
    updates: [],
    more: false,
    notModified: /^HTTP\/\S+ 304\b/u.test(headers),
    pollSeconds: Math.max(60, interval),
  };
  const modified = field("last-modified"),
    date = field("date");
  if (modified !== undefined) result.lastModified = modified;
  if (date !== undefined && Number.isSafeInteger(Date.parse(date)))
    result.serverTime = Date.parse(date);
  if (result.notModified) return result;
  if (!/^HTTP\/\S+ 200\b/u.test(headers)) throw notificationAccessError(stdout);
  const data: unknown = JSON.parse(body);
  if (!Array.isArray(data))
    throw new Error("Invalid GitHub notifications page");
  const rows: unknown[] = data;
  result.updates = rows.map(parseNotification);
  result.more = field("link")?.includes('rel="next"') === true;
  return result;
}
export const githubNotifications: NotificationReader = {
  async identity(signal) {
    const stdout = await request(
      [
        "api",
        "--hostname",
        "github.com",
        "--include",
        "--method",
        "GET",
        "user",
      ],
      signal,
    );
    if (!/^HTTP\/\S+ 200\b/u.test(stdout))
      throw notificationAccessError(stdout);
    const value: unknown = JSON.parse(
      stdout.slice(stdout.search(/\r?\n\r?\n/u)).trim(),
    );
    if (
      !record(value) ||
      typeof value["login"] !== "string" ||
      !/^[A-Za-z0-9-]+$/u.test(value["login"])
    )
      throw new Error("Cannot identify GitHub notification account");
    return "github.com/" + value["login"].toLowerCase();
  },
  async page(query, signal) {
    const params = new URLSearchParams({
      all: "true",
      per_page: "50",
      since: new Date(query.since).toISOString(),
      page: String(query.page),
    });
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      "GET",
      "/notifications?" + params.toString(),
    ];
    if (query.lastModified !== undefined)
      args.push("-H", "If-Modified-Since: " + query.lastModified);
    const stdout = await request(args, signal);
    return parseNotificationResponse(stdout);
  },
};
