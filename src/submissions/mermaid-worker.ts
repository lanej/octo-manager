import { JSDOM } from "jsdom";
import { Type } from "typebox";
import { Check } from "typebox/value";
const Input = Type.Object(
  { diagrams: Type.Array(Type.String({ maxLength: 65536 }), { maxItems: 20 }) },
  { additionalProperties: false },
);
function send(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("Missing parser IPC"));
      return;
    }
    process.send(value, (error: Error | null) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}
async function parseDiagrams(input: unknown): Promise<void> {
  if (!Check(Input, input) || input.diagrams.join("").length > 65536)
    throw new Error("Invalid Mermaid parser input");
  // Default JSDOM does not execute scripts or load linked resources.
  const dom = new JSDOM("");
  try {
    Object.defineProperty(globalThis, "window", { value: dom.window });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
    });
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const blockers: string[] = [];
    for (const [index, diagram] of input.diagrams.entries()) {
      try {
        await mermaid.parse(diagram);
      } catch (error) {
        if (
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof RangeError
        )
          throw error;
        const reason = (error instanceof Error ? error.message : String(error))
          .split("\n")
          .slice(0, 4)
          .join(" ")
          .slice(0, 500);
        blockers.push(
          "Invalid Mermaid diagram " + String(index + 1) + ": " + reason,
        );
      }
    }
    await send({ blockers });
  } finally {
    dom.window.close();
  }
}
process.once("message", (input: unknown) => {
  parseDiagrams(input)
    .then(
      () => {
        process.exit(0);
      },
      async (error: unknown) => {
        try {
          await send({
            failure:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Mermaid parser failed",
          });
        } finally {
          process.exit(1);
        }
      },
    )
    .catch(() => {
      process.exit(1);
    });
});
