/**
 * 个人账户模型目录解析测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.4）。
 *
 * ChatGPT-plan token 的 `/v1/models` 返回 `{ models: [...] }`（demo 形态）；标准 OpenAI
 * 返回 `{ data: [...] }`。两者都要能解析，避免静默空目录；但只投影 `CHATGPT_ALLOWED_MODEL_IDS`
 * 里经过验证的模型（用户调整：仅 gpt-6.1-sol 与 gpt-6-astra）。
 */
import { describe, expect, it } from "vitest";
import { parseAccountModels, createChatGptModelCatalog, CHATGPT_ALLOWED_MODEL_IDS } from "../src/backend/models.js";

describe("parseAccountModels", () => {
  it("只保留 allowlist 内的可用模型（过滤其它 list/hidden）", () => {
    const models = parseAccountModels({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" },
        { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list" },
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
        { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" }
      ]
    });
    // 按 allowlist 顺序输出（默认模型稳定为第一个）。
    expect(models).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" }
    ]);
    expect(CHATGPT_ALLOWED_MODEL_IDS).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
  });

  it("兼容标准 OpenAI 的 { data } 形态", () => {
    const models = parseAccountModels({
      data: [
        { id: "gpt-6-astra", visibility: "list" },
        { id: "gpt-6.1-sol", visibility: "list" }
      ]
    });
    expect(models).toEqual([
      { id: "gpt-6.1-sol", label: "gpt-6.1-sol" },
      { id: "gpt-6-astra", label: "gpt-6-astra" }
    ]);
  });

  it("缺少 models/data 数组时返回空数组", () => {
    expect(parseAccountModels({})).toEqual([]);
    expect(parseAccountModels(null)).toEqual([]);
  });
});

describe("createChatGptModelCatalog", () => {
  it("使用本用户 token 请求并按 allowlist 解析", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const catalog = createChatGptModelCatalog({
      fetchImpl: (async (url: string, init?: { headers?: Record<string, string> }) => {
        seen.push({ url, auth: init?.headers?.Authorization });
        return { ok: true, status: 200, json: async () => ({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" }] }) };
      }) as never
    });
    const result = await catalog.list("tok-123");
    expect(result.ok && result.models[0]!.id).toBe("gpt-6-astra");
    expect(seen[0]!.auth).toBe("Bearer tok-123");
  });
});
