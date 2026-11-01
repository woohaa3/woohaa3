import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { withAgentImageFiles } from "./candidate-generation.js";

describe("assistant candidate execution", () => {
  it.each([false, true])("temporary native image files are removed after failure=%s", async fail => {
    let file = "";
    const operation = withAgentImageFiles([{ bytes: new Uint8Array([7,8]), contentType: "image/png" }], async files => {
      file = files[0]!; expect([...await readFile(file)]).toEqual([7,8]);
      if (fail) throw new Error("stopped");
    });
    if (fail) await expect(operation).rejects.toThrow("stopped"); else await operation;
    await expect(access(file)).rejects.toThrow();
  });
});
