import type { ParsedCommand } from "../cli/arguments.js";
import { schedulerClient } from "../client.js";
import { printResult } from "../cli/output.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { unwire } from "../api/codec.js";
import {
  DomainArchivedSubmissionSchema,
  DomainArchivedSubmissionSummarySchema,
  DomainRepositoryPolicySchema,
} from "../gen/octomanager/v2/domain_pb.js";

export async function submissionsCLI(parsed: ParsedCommand): Promise<void> {
  const [command, id] = parsed.positionals;
  const client = schedulerClient(resolve(parsed.values.state ?? join(homedir(), ".local/state/octo-manager")));
  if (command === "legacy-submissions") {
    const response = await client.listSubmissions({
      beforeRowId: BigInt(parsed.values.after ?? "0"),
      limit: 20,
    });
    printResult(parsed, {
      submissions: response.submissions.map((value) => unwire(DomainArchivedSubmissionSummarySchema, value)),
      nextBeforeRowId: response.nextBeforeRowId,
    });
  } else if (command === "legacy-submission") {
    const response = await client.getSubmission({ id: id ?? "" });
    if (response.submission === undefined) throw new Error("Missing archived submission");
    printResult(parsed, unwire(DomainArchivedSubmissionSchema, response.submission));
  } else {
    const response = await client.getRepositoryPolicy({
      repository: id ?? "",
      version: parsed.values["policy-version"] === undefined ? undefined : Number(parsed.values["policy-version"]),
      tier: parsed.values.tier ?? "standard",
    });
    if (response.policy === undefined) throw new Error("Missing archived policy");
    printResult(parsed, {
      policy: unwire(DomainRepositoryPolicySchema, response.policy),
      template: response.template,
    });
  }
}
