import { createHash } from "node:crypto";
import type { ReviewFeedback, ReviewObservation } from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === "string" && value !== "") return value;
  throw new Error("Invalid GitHub feedback identity");
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit)
    throw new Error("Invalid GitHub feedback text");
  return value;
}
function feedbackUrl(value: unknown, prUrl: string): string {
  const url = new URL(text(value, 4000));
  const pr = new URL(prUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.pathname.toLowerCase() !== pr.pathname.toLowerCase()
  )
    throw new Error("Comment URL does not match PR");
  return url.href;
}
export function reviewObservation(
  value: unknown,
  prUrl: string,
): ReviewObservation {
  if (!object(value) || !object(value["user"]))
    throw new Error("Invalid GitHub review");
  const submittedAt = Date.parse(text(value["submitted_at"] ?? "", 100));
  return {
    id: identifier(value["id"]),
    author: text(value["user"]["login"], 200),
    headSha: text(value["commit_id"] ?? "", 200),
    state: text(value["state"], 100),
    at: Number.isNaN(submittedAt) ? 0 : submittedAt,
    url: feedbackUrl(value["html_url"] ?? prUrl, prUrl),
    ...(value["body"] === undefined || value["state"] === "PENDING"
      ? {}
      : { body: text(value["body"], 65536) }),
  };
}
export function feedbackRevision(
  input: Omit<ReviewFeedback, "revision">,
): ReviewFeedback {
  const content = {
    source: input.source,
    id: input.id,
    author: input.author,
    body: input.body,
    headSha: input.headSha,
    path: input.path,
    reviewId: input.reviewId,
  };
  return {
    ...input,
    revision: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
  };
}
export function commentFeedback(
  value: unknown,
  source: "inline" | "conversation",
  prUrl: string,
): ReviewFeedback {
  if (!object(value) || !object(value["user"]))
    throw new Error("Invalid GitHub comment");
  const url = feedbackUrl(value["html_url"], prUrl);
  const line = value["line"];
  if (
    line !== undefined &&
    line !== null &&
    (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)
  )
    throw new Error("Invalid comment line");
  return feedbackRevision({
    source,
    id: identifier(value["id"]),
    author: text(value["user"]["login"], 200),
    body: text(value["body"], 65536),
    url,
    ...(source !== "inline"
      ? {}
      : {
          headSha: text(value["commit_id"], 200),
          path: text(value["path"], 4000),
          reviewId: identifier(value["pull_request_review_id"]),
          ...(typeof line === "number" ? { line } : {}),
        }),
  });
}

export function storedFeedback(
  value: unknown,
): import("./types.js").ObservationPart<ReviewFeedback[]> | undefined {
  if (value === null || value === undefined) return undefined;
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!object(raw)) throw new Error("Invalid stored feedback");
  const state = raw["state"];
  if (state === "unavailable")
    return { state, reason: text(raw["reason"], 4000) };
  if (
    (state !== "complete" && state !== "partial") ||
    !Array.isArray(raw["value"])
  )
    throw new Error("Invalid stored feedback state");
  const items: unknown[] = raw["value"];
  const decoded = items.map((item): ReviewFeedback => {
    if (
      !object(item) ||
      (item["source"] !== "review" &&
        item["source"] !== "inline" &&
        item["source"] !== "conversation")
    )
      throw new Error("Invalid stored feedback source");
    const result: ReviewFeedback = {
      source: item["source"],
      id: identifier(item["id"]),
      revision: text(item["revision"], 64),
      author: text(item["author"], 200),
      body: text(item["body"], 65536),
      url: text(item["url"], 4000),
    };
    for (const key of ["headSha", "path", "reviewId"] as const) {
      if (item[key] !== undefined) result[key] = text(item[key], 4000);
    }
    const line = item["line"];
    if (line !== undefined) {
      if (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)
        throw new Error("Invalid stored comment line");
      result.line = line;
    }
    return result;
  });
  return state === "complete"
    ? { state, value: decoded }
    : { state, value: decoded, reason: text(raw["reason"], 4000) };
}
