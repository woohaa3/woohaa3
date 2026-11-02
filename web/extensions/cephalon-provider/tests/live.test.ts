import { describe, expect, it } from "vitest";
import { createCephalonProvider } from "../src/provider.js";
import { discoverCephalonModels } from "../src/discovery.js";

/**
 * 联机核对（默认跳过）：直接打端脑云的模型列表与对话接口，确认发现结果与文本协议在线上成立。
 *
 * 运行：`CEPHALON_API_KEY=… pnpm --filter @woohaa3/extension-cephalon-provider exec vitest run tests/live.test.ts`
 *
 * 图片与视频需要账号有可用额度，这里的账号曾因脑力值不足被平台拒绝（业务码 30002），
 * 因此只断言「失败也是可读的失败」，不把余额问题伪装成协议通过。
 */
const apiKey = process.env.CEPHALON_API_KEY ?? "";
const live = apiKey !== "" ? describe : describe.skip;

live("端脑云线上接口", () => {
  it("模型列表按 model_type 分类，且不含内置清单", async () => {
    const result = await discoverCephalonModels({ apiKey });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    const kinds = new Set(result.models.map((model) => model.modelType));
    expect(kinds).toEqual(new Set(["language", "image", "video"]));
    const ids = result.models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 2026-11-02 快照里的非生成类型。
    expect(ids).not.toContain("reader");
    expect(ids).not.toContain("apiSearchBrave");
    expect(ids).toContain("NanoBanana2");
    expect(ids).toContain("seedance-2.5");
  }, 60_000);

  it("文本模型返回可读内容，错误信息不含 Key", async () => {
    const discovered = await discoverCephalonModels({ apiKey });
    if (!discovered.ok) throw new Error(discovered.message);
    const text = discovered.models.find((model) => model.modelType === "language");
    if (!text) throw new Error("平台没有返回文本模型");
    const provider = createCephalonProvider({
      apiKey,
      models: discovered.models
    });
    // 多数文本模型是 reasoning 模型：`max_tokens` 太小会全被推理 token 吃掉，`content` 为空。
    // 这里给足预算，断言的是「有可读文本返回」而不是「推理不耗 token」。
    const result = await provider.languageModel(text.id).doGenerate?.({
      messages: [{ role: "user", content: [{ type: "text", text: "只回复两个字：好的" }] }],
      maxTokens: 2000
    } as never);
    const content = result && "content" in result ? result.content : [];
    const first = content[0];
    expect(first && first.type === "text" ? first.text.trim() : "").not.toBe("");

    // 错误 Key 必须给可读失败，且不回显凭据。
    const broken = createCephalonProvider({
      apiKey: "sk-invalid-key-for-test",
      models: [{ id: text.id, modelType: "language", title: text.id }]
    });
    let message = "";
    try {
      await broken.languageModel(text.id).doGenerate?.({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxTokens: 2000
      } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("sk-invalid-key-for-test");
  }, 120_000);
});
