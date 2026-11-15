import { expect, test } from "bun:test";
import { publicImageUrl } from "../src/submissions/artifacts.js";
test("image destinations reject local names and alternate loopback spellings before network access", () => {
  for (const url of [
    "https://localhost./image.png",
    "https://x.localhost/image.png",
    "https://127.0.0.2/image.png",
    "https://127.1/image.png",
    "https://[::1]/image.png",
    "https://[::ffff:127.0.0.1]/image.png",
    "https://10.1.2.3/image.png",
  ])
    expect(() => publicImageUrl(url)).toThrow();
  expect(
    publicImageUrl("https://github.com/user-attachments/assets/example")
      .hostname,
  ).toBe("github.com");
});
