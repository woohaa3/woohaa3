import { describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../src/provider.js";
import { discoverDeepSeekModels } from "../src/discovery.js";

/**
 * 联机核对（默认跳过）：直接打 DeepSeek 官方模型列表与对话接口，确认发现结果与文本协议在线上成立。
 *
 * 运行：`DEEPSEEK_API_KEY=… pnpm --filter @woohaa3/extension-deepseek-provider exec vitest run tests/live.test.ts`
 *
 * 思考模式默认开启，`max_tokens` 给得小会全被推理 token 吃掉、`content` 为空，所以这里
 * 明确关掉思考再断言「有可读文本」，而不是把推理耗 token 当成协议失败。
 */
const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const live = apiKey !== "" ? describe : describe.skip;

live("DeepSeek 线上接口", () => {
  it("模型列表自带能力元数据，且不依赖内置清单", async () => {
    const result = await discoverDeepSeekModels({ apiKey });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.models.length).toBeGreaterThan(0);
    const ids = result.models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 官方快照里的两个模型名（2026-11-10）；新模型上线时这条需要跟着更新。
    expect(ids).toContain("deepseek-flash");
    // 至少有一个模型声明了思考档位——目录元数据真的能用上。
    expect(result.models.some((model) => (model.reasoningEfforts?.length ?? 0) > 0)).toBe(true);
  }, 60_000);

  it("文本模型返回可读内容，错误信息不含 Key", async () => {
    const discovered = await discoverDeepSeekModels({ apiKey });
    if (!discovered.ok) throw new Error(discovered.message);
    const text = discovered.models[0]!;
    const provider = createDeepSeekProvider({ apiKey, models: discovered.models });
    const result = await provider.languageModel(text.id).doGenerate?.({
      prompt: [{ role: "user", content: [{ type: "text", text: "只回复两个字：好的" }] }],
      maxOutputTokens: 2000,
      providerOptions: { deepseek: { thinking: "disabled" } }
    } as never);
    const content = result && "content" in result ? result.content : [];
    const first = content[0];
    expect(first && first.type === "text" ? first.text.trim() : "").not.toBe("");

    // 错误 Key 必须给可读失败，且不回显凭据。
    const broken = createDeepSeekProvider({
      apiKey: "sk-invalid-key-for-test",
      models: [{ id: text.id, title: text.title, supportsVision: false }]
    });
    let message = "";
    try {
      await broken.languageModel(text.id).doGenerate?.({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 64
      } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("sk-invalid-key-for-test");
  }, 120_000);
});
