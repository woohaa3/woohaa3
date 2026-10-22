import { describe, expect, it } from "vitest";
import { discoverFalModels } from "../src/discovery.js";

/**
 * 联机核对（默认跳过）：直接打 fal 的公开定义接口，确认分类与字段映射在线上成立。
 * 运行：`FAL_LIVE=1 pnpm --filter @woohaa3/extension-fal-provider exec vitest run tests/live.test.ts`
 */
describe.runIf(process.env.FAL_LIVE === "1")("fal 线上定义", () => {
  it("真实 endpoint 都能读成可执行模型，语音转写被跳过", async () => {
    const result = await discoverFalModels({
      modelIds: ["fal-ai/flux/schnell", "fal-ai/kling-video/v3/pro/text-to-video", "openrouter/router", "fal-ai/whisper"]
    });
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    const kinds = Object.fromEntries(result.models.map((model) => [model.id, model.modelType]));
    expect(Object.keys(kinds).sort()).toEqual(["fal-ai/flux/schnell", "fal-ai/kling-video/v3/pro/text-to-video", "openrouter/router"]);
    expect(kinds).toMatchObject({
      "fal-ai/flux/schnell": "image",
      "fal-ai/kling-video/v3/pro/text-to-video": "video",
      "openrouter/router": "language"
    });
    const flux = result.models.find((model) => model.id === "fal-ai/flux/schnell");
    expect(flux?.promptRequirement).toBe("required");
    expect(Object.keys(flux?.inputSchema.properties as object)).toContain("prompt");
  }, 60_000);
});
