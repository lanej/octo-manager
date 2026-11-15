import { wireInput, submissionFromWire, policyFromWire } from "./wire.js";
import { parsedConfig } from "./public-contracts.js";
import { readContract, explainContract } from "./pr-contract.js";
import { printResult } from "../cli-output.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseCommand, directoryLabel } from "../arguments.js";
import { schedulerClient } from "../client.js";
import {
  SubmissionInputSchema,
  SubmissionState,
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
      "pr",
      "config",
      "submit-pr",
      "submission",
      "submissions",
      "retry-submission",
      "cancel-submission",
      "repo-policy",
    ].includes(command)
  )
    return false;
  if ((command === "config" || command === "pr") && values.help === true) {
    console.log(
      "PR contracts: pr prepare|validate --input FILE [--config PATH] [--description-file FILE --title TITLE] [--no-wait]; pr publish PREPARATION_ID. Configuration: config validate|explain [--config PATH]. Inspect durable operations with submission ID --full.",
    );
    return true;
  }
  if (command === "config") {
    if (argument !== "validate" && argument !== "explain")
      throw new Error("Use config validate|explain [--config PATH]");
    const cwd = resolve(values.cwd ?? process.cwd());
    let path: string | undefined =
      values.config === undefined ? undefined : resolve(cwd, values.config);
    let source: string | undefined;
    if (path === undefined) {
      const root = (
        await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd,
          timeout: 30000,
        })
      ).stdout.trim();
      path = join(root, "octo-manager.toml");
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    } else source = await readFile(path, "utf8");
    const effective = readContract(source);
    printResult(parsed, {
      valid: true,
      source: source === undefined ? "versioned defaults" : path,
      effective,
      origins: explainContract(source, path).values,
      authored: source === undefined ? null : Bun.TOML.parse(source),
      note: "Authored selections override versioned defaults; publication discovers repository configuration from the target base revision. Explicit --config is a recorded local override.",
    });
    return true;
  }
  if (
    command === "pr" &&
    !["prepare", "validate", "publish"].includes(argument ?? "")
  )
    return false;
  const directory = resolve(
    values.state ??
      process.env["OCTO_MANAGER_STATE"] ??
      join(homedir(), ".local", "state", "octo-manager"),
  );
  const client = schedulerClient(directory);
  let result: unknown;
  if (command === "pr" && argument === "publish") {
    result = submissionFromWire(
      (await client.publishPreparedPullRequest({ id: positionals[2] ?? "" }))
        .submission,
    );
  } else if (command === "submissions")
    result = (await client.listSubmissions({})).submissions.map(
      submissionFromWire,
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
    result = submissionFromWire(response.submission);
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
      if (values.json) printResult(parsed, { template: response.template });
      else console.log(response.template);
      return true;
    }
    result = policyFromWire(response.policy);
  } else if (
    command === "submit-pr" ||
    command === "pr" ||
    (command === "repo-policy" && argument === "refresh")
  ) {
    let raw: unknown;
    const inputFile = values.input ?? values["intent-file"];
    if (inputFile !== undefined)
      raw = JSON.parse(await readFile(resolve(inputFile), "utf8"));
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
    const contractToml =
      values.config === undefined
        ? undefined
        : await readFile(
            resolve(values.cwd ?? process.cwd(), values.config),
            "utf8",
          );
    if (contractToml !== undefined) readContract(contractToml);
    const descriptionBody =
      values["description-file"] === undefined
        ? undefined
        : await readFile(
            resolve(values.cwd ?? process.cwd(), values["description-file"]),
            "utf8",
          );
    const request = parse(SubmissionInputSchema, {
      ...raw,
      ...(command !== "pr" ? {} : { mode: argument }),
      ...(values["head-repo"] === undefined
        ? {}
        : { headRepository: values["head-repo"] }),
      ...(values.url === undefined ? {} : { updateUrl: values.url }),
      ...(contractToml === undefined
        ? {}
        : parsedConfig(
            contractToml,
            resolve(
              values.cwd ?? process.cwd(),
              values.config ?? "octo-manager.toml",
            ),
          )),
      ...(descriptionBody === undefined
        ? {}
        : {
            description: {
              title:
                values.title ??
                ("description" in raw &&
                typeof raw.description === "object" &&
                raw.description !== null &&
                "title" in raw.description
                  ? raw.description.title
                  : ""),
              body: descriptionBody,
            },
          }),
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
    if (inputFile === undefined && values["request-id"] === undefined) {
      request.requestId = hash(
        Object.fromEntries(
          Object.entries(request).filter(([key]) => key !== "requestId"),
        ),
      );
    }
    let submitted = submissionFromWire(
      (await client.submitPullRequest({ input: wireInput(request) }))
        .submission,
    );
    if (command === "pr" && values["no-wait"] !== true) {
      const deadline = Date.now() + 600000;
      while (
        ["queued", "analyzing", "writing", "publishing", "enrolling"].includes(
          submitted.state,
        )
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "Operation still running; inspect submission " + submitted.id,
          );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        submitted = submissionFromWire(
          (await client.getSubmission({ id: submitted.id })).submission,
        );
      }
      if (submitted.state !== SubmissionState.Succeeded) process.exitCode = 1;
    }
    result = submitted;
  } else
    throw new Error(
      "Use repo-policy get|template --repo owner/repo or refresh from a pushed branch",
    );
  printResult(parsed, result);
  return true;
}
