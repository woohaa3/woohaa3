import { describe, expect, it } from "vitest";
import {
  isSupportedModelScript,
  isWritableModelScriptLanguage,
  MODEL_SCRIPT_LANGUAGE,
  MODEL_SCRIPT_V2_VERSION
} from "./model-script.js";

describe("model script language contract", () => {
  it("accepts the versioned JavaScript marker", () => {
    expect(isSupportedModelScript({ language: MODEL_SCRIPT_LANGUAGE, version: MODEL_SCRIPT_V2_VERSION })).toBe(true);
    expect(isWritableModelScriptLanguage(MODEL_SCRIPT_LANGUAGE, MODEL_SCRIPT_V2_VERSION)).toBe(true);
  });

  it("treats missing markers as unsupported", () => {
    expect(isSupportedModelScript({})).toBe(false);
    expect(isSupportedModelScript({ language: undefined, version: undefined })).toBe(false);
    expect(isSupportedModelScript({ language: "", version: "" })).toBe(false);
  });

  it("treats explicit gdscript as unsupported", () => {
    expect(isSupportedModelScript({ language: "gdscript", version: "v1" })).toBe(false);
  });

  it("rejects unknown-but-present languages", () => {
    expect(isSupportedModelScript({ language: "python", version: "x" })).toBe(false);
    expect(isSupportedModelScript({ language: "python", version: MODEL_SCRIPT_V2_VERSION })).toBe(false);
  });

  it("rejects the retired V1 script version", () => {
    expect(isSupportedModelScript({ language: MODEL_SCRIPT_LANGUAGE, version: "woohaa-model-js-v1" })).toBe(false);
    expect(isWritableModelScriptLanguage(MODEL_SCRIPT_LANGUAGE, "woohaa-model-js-v1")).toBe(false);
  });

  it("rejects mismatched language/version combinations", () => {
    expect(isWritableModelScriptLanguage("javascript", "other")).toBe(false);
    expect(isWritableModelScriptLanguage("gdscript", MODEL_SCRIPT_V2_VERSION)).toBe(false);
  });
});
