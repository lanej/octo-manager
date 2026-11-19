import { isDeepStrictEqual } from "node:util";
import { Waiting, validateBrief, type IssueRecord } from "./contracts.js";
import {
  contentOf,
  sameContent,
  type IssueContent,
  type IssueRepository,
} from "./repository.js";
import type { IssueStore } from "./store.js";

function reconcile(
  local: IssueContent,
  remote: IssueContent,
  base: IssueContent | undefined,
  conflict: (detail: string) => void,
): IssueContent {
  const next = { ...remote, fieldTimes: { ...remote.fieldTimes } };
  for (const field of ["title", "body", "externalClosed", "brief"] as const) {
    const left = local[field];
    const right = remote[field];
    const old = base?.[field];
    const localAt = local.fieldTimes?.[field] ?? local.updatedAt;
    const remoteAt = remote.fieldTimes?.[field] ?? remote.updatedAt;
    const changedLocal = !isDeepStrictEqual(left, old);
    const changedRemote = !isDeepStrictEqual(right, old);
    if (changedLocal && changedRemote && !isDeepStrictEqual(left, right))
      conflict(
        JSON.stringify({
          field,
          local: left,
          stored: right,
          localAt,
          storedAt: remoteAt,
          winner: localAt > remoteAt ? "local" : "stored",
        }),
      );
    if (changedLocal && (!changedRemote || localAt > remoteAt)) {
      Object.assign(next, { [field]: left });
      next.fieldTimes[field] = localAt;
    }
  }
  const comments = new Map(remote.comments.map((item) => [item.id, item]));
  const oldComments = new Map(
    base?.comments.map((item) => [item.id, item]) ?? [],
  );
  for (const item of local.comments) {
    const existing = comments.get(item.id);
    const old = oldComments.get(item.id);
    const localChanged = !isDeepStrictEqual(item, old);
    const remoteChanged = !isDeepStrictEqual(existing, old);
    if (existing === undefined || (localChanged && !remoteChanged))
      comments.set(item.id, item);
    else if (
      localChanged &&
      remoteChanged &&
      !isDeepStrictEqual(item, existing)
    ) {
      const localAt = Date.parse(item.revision);
      const remoteAt = Date.parse(existing.revision);
      const keepLocal =
        (Number.isFinite(localAt) ? localAt : local.updatedAt) >
        (Number.isFinite(remoteAt) ? remoteAt : remote.updatedAt);
      conflict(
        JSON.stringify({
          field: `comment:${item.id}`,
          local: item,
          stored: existing,
          localAt,
          storedAt: remoteAt,
          winner: keepLocal ? "local" : "stored",
        }),
      );
      if (keepLocal) comments.set(item.id, item);
    }
  }
  return {
    ...next,
    comments: [...comments.values()],
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

function receive(store: IssueStore, content: IssueContent): void {
  store.atomic(() => {
    const issue = store.get(content.id);
    if (sameContent(contentOf(issue), content)) return;
    let brief = content.brief;
    const briefChanged = !isDeepStrictEqual(brief, issue.brief);
    if (brief !== undefined && briefChanged) {
      brief = {
        ...brief,
        version: Math.max(brief.version, (issue.brief?.version ?? 0) + 1),
      };
      validateBrief(brief);
    }
    const pending = [...issue.pendingComments];
    for (const comment of content.comments) {
      if (
        !issue.reviewedComments.includes(`${comment.id}:${comment.revision}`) &&
        !pending.some(
          (item) =>
            item.id === comment.id && item.revision === comment.revision,
        )
      )
        pending.push(comment);
    }
    if (issue.title !== content.title || issue.body !== content.body)
      pending.push({
        id: "issue-content",
        revision: String(content.updatedAt),
        author: "issue author",
        body: content.body,
        url: issue.ref.url,
      });
    const next: IssueRecord = {
      ...issue,
      title: content.title,
      body: content.body,
      comments: content.comments,
      externalClosed: content.externalClosed,
      brief,
      pendingComments: pending,
      epoch: issue.epoch + 1,
      approvedVersion: briefChanged ? 0 : issue.approvedVersion,
      publicationVersion: briefChanged ? 0 : issue.publicationVersion,
      waiting:
        issue.waiting === Waiting.Paused || content.externalClosed
          ? Waiting.Paused
          : briefChanged
            ? Waiting.Approval
            : Waiting.None,
      nextAt: 0,
      detail: content.externalClosed
        ? "Issue closed externally; dispatch paused"
        : "Stored issue input changed; assessment required",
    };
    store.save(next, "storage_observed", next.detail);
    const fieldsChanged =
      issue.title !== next.title ||
      issue.body !== next.body ||
      issue.externalClosed !== next.externalClosed;
    if (fieldsChanged)
      store.effect({
        id: `${issue.id}:storage:${String(content.updatedAt)}`,
        issueId: issue.id,
        kind: "sync_content",
        body: JSON.stringify({
          title: next.title,
          body: next.body,
          closed: next.externalClosed,
        }),
        title: "",
        state: "intended",
        url: "",
      });
    for (const comment of content.comments.filter(
      (item) =>
        item.id.startsWith("local:") &&
        !issue.comments.some(
          (old) => old.id === item.id && old.revision === item.revision,
        ),
    ))
      store.effect({
        id: `${issue.id}:comment:${comment.id}:${comment.revision}`,
        issueId: issue.id,
        kind: "sync_comment",
        body: `${comment.author}:\n\n${comment.body}`,
        title: "",
        state: "intended",
        url: "",
      });
  });
}

/** Flushes durable intentions before lifecycle effects; no storage failure releases work. */
export async function synchronizeIssue(
  store: IssueStore,
  issue: IssueRecord,
  repository: IssueRepository | undefined,
  signal: AbortSignal,
): Promise<void> {
  const journal = store.repository;
  const binding = journal.get(issue.id);
  if (repository === undefined) {
    if (binding !== undefined)
      throw new Error(
        "Enrolled issue storage is unavailable; configure its repository",
      );
    return;
  }
  if (binding === undefined)
    throw new Error("Existing issue requires explicit storage migration");
  if (binding.repository !== repository.identity)
    throw new Error("Issue storage identity changed; migrate explicitly");
  try {
    const observed = await repository.read(issue.id, signal);
    if (observed !== undefined && binding.baseline !== undefined) {
      const fieldTimes = { ...observed.fieldTimes };
      for (const field of [
        "title",
        "body",
        "externalClosed",
        "brief",
      ] as const) {
        if (isDeepStrictEqual(observed[field], binding.baseline[field]))
          fieldTimes[field] =
            binding.baseline.fieldTimes?.[field] ?? binding.baseline.updatedAt;
      }
      observed.fieldTimes = fieldTimes;
    }
    const current = journal.get(issue.id);
    if (current === undefined)
      throw new Error("Issue storage enrollment disappeared");
    if (observed === undefined && current.baseline !== undefined)
      throw new Error("Authoritative issue content is missing");
    let content = observed;
    if (current.pending !== undefined) {
      content =
        observed === undefined
          ? current.pending
          : reconcile(current.pending, observed, current.baseline, (detail) => {
              store.save(store.get(issue.id), "storage_conflict", detail);
            });
      if (observed === undefined || !sameContent(content, observed))
        await repository.write(content, signal, observed);
      const confirmed = await repository.read(issue.id, signal);
      if (confirmed === undefined || !sameContent(content, confirmed))
        throw new Error("Issue storage write remains unconfirmed");
      content = confirmed;
    }
    if (content === undefined)
      throw new Error("Authoritative issue content is missing");
    journal.confirm(content, current.pending);
    if (!journal.ready(issue.id)) return;
    if (binding.error !== "") {
      const recovered = store.get(issue.id);
      store.save(
        {
          ...recovered,
          detail: "Issue storage recovered; workflow retained",
          nextAt: 0,
        },
        "storage_recovered",
        "Issue repository available",
      );
    }
    receive(store, content);
    const received = journal.get(issue.id);
    if (
      received?.pending !== undefined &&
      sameContent(content, received.pending)
    )
      journal.confirm(content, received.pending);
  } catch (error) {
    journal.fail(
      issue.id,
      error instanceof Error ? error.message : "Issue storage unavailable",
    );
    throw error;
  }
}
