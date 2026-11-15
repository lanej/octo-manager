import {
  PublicInputSchema,
  PublicBriefSchema,
  PublicSubmissionViewSchema,
} from "../src/submissions/public-contracts.js";
import {
  ContractSchema,
  DecisionSchema,
} from "../src/submissions/pr-contract.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicySchema } from "../src/submissions/contracts.js";
const directory = new URL("../schemas/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({
  "pr-contract.v1": ContractSchema,
  "pr-decision.v1": DecisionSchema,
  "pr-intent.v1": PublicInputSchema,
  "repository-pr-policy.v1": PolicySchema,
  "pr-brief.v1": PublicBriefSchema,
  "pr-submission.v1": PublicSubmissionViewSchema,
})) {
  await writeFile(
    join(directory.pathname, `${name}.schema.json`),
    JSON.stringify(
      { $schema: "http://json-schema.org/draft-07/schema#", ...schema },
      null,
      2,
    ) + "\n",
  );
}
