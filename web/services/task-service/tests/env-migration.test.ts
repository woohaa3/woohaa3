/**
 * Task Service 凭据环境变量契约（change: 2026-10-07-remove-residual-compatibility）。
 *
 * 只接受当前 `LITELLM_*` 变量；旧 `PPTASK_LITELLM_*` 已下线。
 */
import { describe, expect, it } from "vitest";
import { readPptaskEnv } from "../src/config/env.js";

describe("readPptaskEnv", () => {
  it("读取 LITELLM_* 变量", () => {
    const result = readPptaskEnv({ LITELLM_API_KEY: "k", LITELLM_BASE_URL: "https://llm.example/v1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ apiKey: "k", baseUrl: "https://llm.example/v1" });
  });

  it("旧 PPTASK_LITELLM_* 不再被读取", () => {
    const result = readPptaskEnv({ PPTASK_LITELLM_API_KEY: "old", PPTASK_LITELLM_BASE_URL: "https://old.example" });
    expect(result.ok).toBe(false);
  });

  it("缺少凭据时返回可诊断原因且不泄露值", () => {
    const result = readPptaskEnv({ LITELLM_API_KEY: "k" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("LITELLM_BASE_URL");
    expect(result.reason).not.toContain("k");
  });
});
