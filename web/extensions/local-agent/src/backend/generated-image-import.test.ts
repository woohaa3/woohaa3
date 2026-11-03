import { describe, expect, it } from "vitest";
import { generatedImageImportFailure } from "./generated-image-import.js";

describe("generatedImageImportFailure", () => {
  it("生图但未导入时失败", () => {
    expect(generatedImageImportFailure(2, false)).toMatchObject({ code: "image-not-imported" });
  });

  it("生图并导入后不拦截", () => {
    expect(generatedImageImportFailure(2, true)).toBeNull();
  });

  it("未生图时不拦截", () => {
    expect(generatedImageImportFailure(0, false)).toBeNull();
  });
});
