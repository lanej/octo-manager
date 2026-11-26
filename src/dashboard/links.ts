import { Buffer } from "node:buffer";
import { MAX_LINK_URL_BYTES } from "@opentui/core";

export interface DashboardLink {
  label: string;
  url: string;
}

export function dashboardLink(value: string): DashboardLink | undefined {
  if (
    !/^https?:\/\//u.test(value) ||
    /[\s\p{Cc}\p{Cf}<>\\]/u.test(value) ||
    Buffer.byteLength(value) > MAX_LINK_URL_BYTES
  )
    return undefined;
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    return undefined;
  }
  if (address.username !== "" || address.password !== "") return undefined;
  if (address.origin !== "https://github.com") {
    return {
      label: address.host + address.pathname + address.search + address.hash,
      url: value,
    };
  }

  const pull = /^(\/[\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/u.exec(
    address.pathname,
  );
  if (pull?.[1] !== undefined && pull[2] !== undefined) {
    const anchor = address.hash.slice(1);
    const detail =
      /^(pullrequestreview|discussion_r|issuecomment)-?(\d+)$/u.exec(anchor);
    const description =
      detail?.[1] === "pullrequestreview"
        ? "review"
        : detail?.[1] === "discussion_r"
          ? "thread"
          : "comment";
    const suffix =
      detail?.[2] !== undefined
        ? ` · ${description} ${detail[2]}`
        : anchor === ""
          ? ""
          : ` · ${anchor}`;
    return { label: `${pull[1].slice(1)} #${pull[2]}${suffix}`, url: value };
  }

  const path = address.pathname.slice(1);
  return {
    label: (path === "" ? address.host : path) + address.search + address.hash,
    url: value,
  };
}

export function markdownReference(value: string): string | undefined {
  const address = dashboardLink(value);
  if (address === undefined) return undefined;
  const label = address.label.replace(/[\\[\]]/gu, "\\$&");
  return `[${label}](<${address.url}>)`;
}
