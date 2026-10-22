/**
 * 转换提供方集合的选择/路由测试
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1 / design D6）。
 *
 * 覆盖：显式 modelKey 只在其所属 Provider 内解析（不静默换 Provider）、未指定 modelKey 按
 * 登记顺序选择能承担来源的候选、无候选返回 null、生成端口按 modelKey 路由到正确 Provider。
 * 非渲染检查。
 */
import { describe, expect, it } from "vitest";
import {
  createFilmSetConversionProviderSet,
  type FilmSetConversionAdapterCapabilities,
  type FilmSetConversionMediaReader,
  type FilmSetConversionProvider
} from "@woohaa3/contracts";

const IMAGE_CAPS: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: true,
  input: { imageInput: true, maxImages: 4, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 }
};
const VIDEO_CAPS: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: true,
  input: { imageInput: true, maxImages: 12, videoInput: false, maxFrames: 12, maxDurationSeconds: 0 }
};

function reader(): FilmSetConversionMediaReader {
  return { readAsset: async () => ({ bytes: new Uint8Array([1]), contentType: "image/png" }) };
}

function provider(input: {
  providerId: string;
  models: Array<{ modelKey: string; supports: Array<"image" | "video" | "model3d">; capabilities: FilmSetConversionAdapterCapabilities }>;
  onGenerator?: (modelKey: string) => void;
}): FilmSetConversionProvider {
  return {
    providerId: input.providerId,
    listModels: () => input.models.map((model) => ({ modelKey: model.modelKey, label: model.modelKey, capabilities: model.capabilities, supports: model.supports })),
    resolveCapabilities: ({ modelKey, sourceKind }) => {
      const match = modelKey
        ? input.models.find((model) => model.modelKey === modelKey)
        : input.models.find((model) => model.supports.includes(sourceKind));
      if (!match) return null;
      return { modelKey: match.modelKey, capabilities: match.capabilities };
    },
    createGenerator: ({ media }) => (generationInput) => {
      input.onGenerator?.(generationInput.modelKey);
      return Promise.resolve({ ok: true, candidate: { provider: input.providerId, media } });
    }
  };
}

describe("createFilmSetConversionProviderSet（任务 2.1 / D6）", () => {
  it("未指定 modelKey 时按登记顺序选择能承担来源的候选", () => {
    const set = createFilmSetConversionProviderSet([
      provider({ providerId: "litellm", models: [{ modelKey: "litellm:text", supports: ["image"], capabilities: IMAGE_CAPS }] }),
      provider({ providerId: "chatgpt", models: [{ modelKey: "chatgpt:gpt-6", supports: ["image", "video"], capabilities: VIDEO_CAPS }] })
    ]);
    expect(set.resolveCapabilities({ sourceKind: "video" })).toEqual({ modelKey: "chatgpt:gpt-6", capabilities: VIDEO_CAPS });
    expect(set.resolveCapabilities({ sourceKind: "image" })).toEqual({ modelKey: "litellm:text", capabilities: IMAGE_CAPS });
  });

  it("显式 modelKey 只在其所属 Provider 内解析，未知模型返回 null（不静默换 Provider）", () => {
    const set = createFilmSetConversionProviderSet([
      provider({ providerId: "chatgpt", models: [{ modelKey: "chatgpt:gpt-6", supports: ["image"], capabilities: IMAGE_CAPS }] })
    ]);
    expect(set.resolveCapabilities({ modelKey: "chatgpt:gpt-6", sourceKind: "image" })?.modelKey).toBe("chatgpt:gpt-6");
    expect(set.resolveCapabilities({ modelKey: "litellm:gemini", sourceKind: "image" })).toBeNull();
  });

  it("没有提供方时生成端口返回 model-not-configured，不冒充成功", async () => {
    const generator = createFilmSetConversionProviderSet([]).createGenerator({ media: reader() });
    expect(generator).not.toBeNull();
    const result = await generator!({ modelKey: "x", frozenSource: { nodeId: "n", kind: "image", contentHash: "h" } } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("model-not-configured");
  });

  it("生成端口按 modelKey 路由到正确 Provider", async () => {
    const calls: string[] = [];
    const set = createFilmSetConversionProviderSet([
      provider({ providerId: "litellm", models: [{ modelKey: "litellm:text", supports: ["image"], capabilities: IMAGE_CAPS }], onGenerator: () => calls.push("litellm") }),
      provider({ providerId: "chatgpt", models: [{ modelKey: "chatgpt:gpt-6", supports: ["image", "video"], capabilities: VIDEO_CAPS }], onGenerator: () => calls.push("chatgpt") })
    ]);
    const generator = set.createGenerator({ media: reader() })!;
    await generator({ modelKey: "chatgpt:gpt-6", frozenSource: { nodeId: "n", kind: "video", contentHash: "h" } } as never);
    await generator({ modelKey: "litellm:text", frozenSource: { nodeId: "n", kind: "image", contentHash: "h" } } as never);
    expect(calls).toEqual(["chatgpt", "litellm"]);
  });
});
