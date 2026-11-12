import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseCommand, directoryLabel } from "../arguments.js";
import { schedulerClient } from "../client.js";
import {
  SubmissionInputSchema,
  SubmissionSchema,
  PolicySchema,
  parse,
  hash,
} from "./contracts.js";
const exec = promisify(execFile);
export async function submissionsCLI(
  parsed: ReturnType<typeof parseCommand>,
): Promise<boolean> {
  const { values, positionals } = parsed,
    [command, argument] = positionals;
  if (
    command === undefined ||
    ![
      "submit-pr",
      "submission",
      "submissions",
      "retry-submission",
      "cancel-submission",
      "repo-policy",
    ].includes(command)
  )
    return false;
  const directory = resolve(
    values.state ??
      process.env["OCTO_MANAGER_STATE"] ??
      join(homedir(), ".local", "state", "octo-manager"),
  );
  const client = schedulerClient(directory);
  let result: unknown;
  if (command === "submissions")
    result = (await client.listSubmissions({})).submissionsJson.map((value) =>
      parse(SubmissionSchema, JSON.parse(value)),
    );
  else if (
    command === "submission" ||
    command === "retry-submission" ||
    command === "cancel-submission"
  ) {
    const request = { id: argument ?? "" };
    const response =
      command === "submission"
        ? await client.getSubmission(request)
        : command === "retry-submission"
          ? await client.retrySubmission(request)
          : await client.cancelSubmission(request);
    result = parse(SubmissionSchema, JSON.parse(response.submissionJson));
  } else if (
    command === "repo-policy" &&
    (argument === "get" || argument === "template")
  ) {
    const response = await client.getRepositoryPolicy({
      repository: values.repo ?? "",
      version:
        values.version === undefined ? undefined : Number(values.version),
      tier: values.tier ?? "standard",
    });
    if (argument === "template") {
      console.log(response.template);
      return true;
    }
    result = parse(PolicySchema, JSON.parse(response.policyJson));
  } else if (
    command === "submit-pr" ||
    (command === "repo-policy" && argument === "refresh")
  ) {
    let raw: unknown;
    if (values["intent-file"] !== undefined)
      raw = JSON.parse(await readFile(resolve(values["intent-file"]), "utf8"));
    else {
      const cwd = resolve(values.cwd ?? process.cwd());
      const read = async (bin: string, args: string[]) =>
        (
          await exec(bin, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
        ).stdout.trim();
      const repository =
        values.repo ??
        (await read("gh", [
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "--jq",
          ".nameWithOwner",
        ]));
      const headRef =
        values.head ?? (await read("git", ["branch", "--show-current"]));
      const headSha = await read("git", ["rev-parse", `${headRef}^{commit}`]);
      const baseRef =
        values.base ??
        (await read("gh", [
          "repo",
          "view",
          repository,
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name",
        ]));
      const context =
        values["body-file"] === undefined
          ? (values.body ?? "")
          : await readFile(resolve(cwd, values["body-file"]), "utf8");
      const purpose =
        values.purpose ?? [values.title, context].filter(Boolean).join("\n\n");
      const owner = {
        harness: "codex",
        endpoint: values.endpoint ?? "local",
        sessionId: values["thread-id"] ?? process.env["CODEX_THREAD_ID"] ?? "",
        label: values.label ?? directoryLabel(cwd),
      };
      const fields = {
        repository,
        headRef,
        headSha,
        baseRef,
        purpose:
          command === "repo-policy" ? "Refresh contribution policy" : purpose,
        validation: [],
        draft: values.draft ?? false,
        owner,
        ...(command === "repo-policy" ? { mode: "policy" } : {}),
      };
      raw = { requestId: values["request-id"] ?? hash(fields), ...fields };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("Invalid submission input");
    const request = parse(SubmissionInputSchema, {
      ...raw,
      ...(values["thread-id"] === undefined
        ? {}
        : {
            owner: {
              harness: "codex",
              endpoint: values.endpoint ?? "local",
              sessionId: values["thread-id"],
              label:
                values.label ?? directoryLabel(values.cwd ?? process.cwd()),
            },
          }),
    });
    result = parse(
      SubmissionSchema,
      JSON.parse(
        (await client.submitPullRequest({ inputJson: JSON.stringify(request) }))
          .submissionJson,
      ),
    );
  } else
    throw new Error(
      "Use repo-policy get|template --repo owner/repo or refresh from a pushed branch",
    );
  console.log(
    JSON.stringify(result, null, values.json === true ? undefined : 2),
  );
  return true;
}
