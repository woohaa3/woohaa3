import { describe, expect, it } from "vitest";
import { discoverGrsaiModels } from "../src/discovery.js";

/**
 * 联机核对（默认跳过）：直接打 grsai 的公开模型表，确认类型分类与下线过滤在线上成立。
 * 运行：`GRSAI_LIVE=1 pnpm --filter @woohaa3/extension-grsai-provider exec vitest run tests/live.test.ts`
 */
describe.runIf(process.env.GRSAI_LIVE === "1")("grsai 线上模型表", () => {
  it("公开接口能发现图片、视频与文本模型，并过滤下线/维护中的模型", async () => {
    const result = await discoverGrsaiModels({ baseUrl: "https://grsai.dakka.com.cn" });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    const kinds = new Set(result.models.map((model) => model.kind));
    expect(kinds).toEqual(new Set(["image", "video", "language"]));
    // 2026-10-16 快照里这两个都是 closeModel/维护中，不应出现。
    expect(result.models.some((model) => model.id === "nano-banana-fast")).toBe(false);
    expect(result.models.some((model) => model.id === "gpt-image-2.5-sunburst")).toBe(false);
    expect(result.models.some((model) => model.id === "minimax-h3")).toBe(true);
    const ids = result.models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);
});
