import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SubmissionInputSchema,
  PolicySchema,
  BriefSchema,
  SubmissionSchema,
} from "../src/submissions/contracts.js";
const directory = new URL("../schemas/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({
  "pr-intent.v1": SubmissionInputSchema,
  "repository-pr-policy.v1": PolicySchema,
  "pr-brief.v1": BriefSchema,
  "pr-submission.v1": SubmissionSchema,
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
