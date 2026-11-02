/**
 * 面板投影：入库清单（上游字段）× 内置卡片（人类语义）。
 *
 * 这些用例守住三件事：卡片接入后**面板键**变了（比例 + 档位，像素字段收起）、
 * **值域是交集**（上游不认的档位不出现）、**提交字段仍是上游形状**（像素由档位算）。
 */
import { describe, expect, it } from "vitest";
import { createRunningHubRegistration } from "../src/backend.js";
import { runningHubCard, runningHubCardSchema, translateRunningHubParameters } from "../src/model-cards.js";
import { findRunningHubModel, runningHubModelDefinition } from "../src/shared.js";

function projection(modelId: string) {
  const model = findRunningHubModel(`api/${modelId}`);
  if (model === undefined) throw new Error(`missing model ${modelId}`);
  const definition = runningHubModelDefinition(model);
  const properties = ((definition.inputSchema ?? {}).properties ?? {}) as Record<string, Record<string, unknown>>;
  return { model, definition, properties, defaults: definition.defaultInput };
}

function enumValues(schema: Record<string, unknown> | undefined): string[] {
  const entries = Array.isArray(schema?.enum) ? schema.enum : [];
  return entries.map((entry) =>
    typeof entry === "string" ? entry : String((entry as { value?: unknown }).value ?? "")
  );
}

describe("卡片映射", () => {
  it("RunningHub 渠道 id 映射到同一个模型的卡片", () => {
    expect(runningHubCard("seedream-v5-lite")?.id).toBe("seedream-5.0-lite");
    expect(runningHubCard("dola-Seedream-5.0-pro")?.id).toBe("seedream-5.0-pro");
    expect(runningHubCard("rhart-image-g-2.5-official-token/flare")?.id).toBe("gpt-image-2.5-flare");
    // 同族不同代可以借用卡片当展示模板：值域仍取交集。
    expect(runningHubCard("rhart-image-g-2")?.id).toBe("gpt-image-2.5");
    expect(runningHubCard("rhart-image-n-g31-flash")?.id).toBe("gemini-3.1-flash-image");
    expect(runningHubCard("rhart-image-n-pro-official")?.id).toBe("nano-banana-2");
    expect(runningHubCard("bytedance/seedance-2.0-global")?.id).toBe("seedance-2.0");
    expect(runningHubCard("seedance-v1-lite")?.id).toBe("seedance-1.0");
    // 认不准的一代不做映射：保持上游自描述。
    expect(runningHubCard("rhart-image-g-3")).toBeUndefined();
    expect(runningHubCard("bytedance/jimeng-4.6")).toBeUndefined();
    // 类型不符不给卡片（图片模型不能挂视频卡）。
    expect(runningHubCard("seedance-v1-lite", "image")).toBeUndefined();
  });
});

describe("即梦：比例 + 档位取代 width/height", () => {
  it("seedream-v5-lite 面板是 比例 + 2K/3K，像素字段收起", () => {
    const { properties, defaults } = projection("seedream-v5-lite");
    expect(properties.width).toBeUndefined();
    expect(properties.height).toBeUndefined();
    expect(enumValues(properties.aspectRatio)).toContain("16:9");
    // 卡片是 2K/3K/4K，上游只认 2k/3k：交集只剩两档，label 仍是卡片写法。
    expect(enumValues(properties.resolution)).toEqual(["2k", "3k"]);
    const resolution = properties.resolution!.enum as Array<{ value: string; label: string }>;
    expect(resolution.map((option) => option.label)).toEqual(["2K", "3K"]);
    expect(defaults).toMatchObject({ resolution: "2k", aspectRatio: "auto" });
    // 上游独有的键照常出现（组图 / 张数 / 联网工具），不被卡片剪掉。
    expect(enumValues(properties.sequentialImageGeneration)).toEqual(["disabled", "auto"]);
    expect(properties.maxImages).toBeDefined();
    expect(enumValues(properties.toolsType)).toEqual(["web_search"]);
  });

  it("比例 + 档位 → 上游 width/height，且不再带 aspectRatio", () => {
    const model = findRunningHubModel("api/seedream-v5-lite")!;
    expect(translateRunningHubParameters(model, { aspectRatio: "16:9", resolution: "2k" })).toEqual({
      resolution: "2k",
      width: 2848,
      height: 1600
    });
    expect(translateRunningHubParameters(model, { resolution: "3k" })).toEqual({
      resolution: "3k",
      width: 3072,
      height: 3072
    });
  });

  it("4.5 的 4K 竖图按官方像素表算", () => {
    const model = findRunningHubModel("api/seedream-v4.5")!;
    expect(translateRunningHubParameters(model, { aspectRatio: "9:16", resolution: "4k" })).toMatchObject({
      width: 3040,
      height: 5504
    });
  });

  it("上游不认的档位不下发（4.0 没有比例表，像素字段保留）", () => {
    const { properties } = projection("seedream-v4");
    expect(properties.aspectRatio).toBeUndefined();
    expect(properties.width).toBeDefined();
    expect(enumValues(properties.resolution)).toEqual(["1k", "2k", "4k"]);
  });
});

describe("GPT Image 2.5：经济版只留上游真的有的键", () => {
  it("低价渠道版没有 质量 / 背景 / 输出格式", () => {
    const { properties } = projection("rhart-image-g-2.5/flare");
    expect(enumValues(properties.aspectRatio)).toContain("16:9");
    expect(enumValues(properties.resolution)).toEqual(["1k", "2k", "4k"]);
    expect(properties.quality).toBeUndefined();
    expect(properties.background).toBeUndefined();
    expect(properties.outputFormat).toBeUndefined();
    expect(properties.n).toBeUndefined();
  });

  it("稳定版保留质量档位，并带 xhigh / max", () => {
    const { properties, defaults } = projection("rhart-image-g-2.5-official-token/sunburst");
    expect(enumValues(properties.quality)).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(enumValues(properties.background)).toEqual(["auto", "transparent", "opaque"]);
    expect(defaults).toMatchObject({ quality: "auto", outputFormat: "png" });
  });

  it("枚举值仍是上游写法（面板 label 才是 2K）", () => {
    const model = findRunningHubModel("api/rhart-image-g-2.5-official-token/flare")!;
    expect(translateRunningHubParameters(model, { resolution: "2k", quality: "xhigh" })).toEqual({
      resolution: "2k",
      quality: "xhigh"
    });
  });
});

describe("Nano Banana / GPT Image 2：卡片只是展示模板，值域仍取交集", () => {
  it("n-g31-flash 用 Gemini 3.1 Flash 的比例与档位（含 1:4 / 8:1）", () => {
    const { properties } = projection("rhart-image-n-g31-flash");
    expect(enumValues(properties.aspectRatio)).toContain("1:4");
    expect(enumValues(properties.aspectRatio)).toContain("8:1");
    expect(enumValues(properties.resolution)).toEqual(["1k", "2k", "4k"]);
  });

  it("lite 档上游没有 resolution，面板就只留比例", () => {
    const { properties } = projection("rhart-image-n-g31-flash-lite");
    expect(enumValues(properties.aspectRatio)).toContain("16:9");
    expect(properties.resolution).toBeUndefined();
  });

  it("n-pro-official 的 quality 是路由键，面板照留", () => {
    const { properties } = projection("rhart-image-n-pro-official");
    expect(enumValues(properties.quality)).toEqual(["standard", "ultra"]);
  });

  it("GPT Image 2 只保留上游认的质量档（不给 xhigh / max）", () => {
    const { properties } = projection("rhart-image-g-2-official");
    expect(enumValues(properties.quality)).toEqual(["low", "medium", "high"]);
    expect(enumValues(properties.resolution)).toEqual(["1k", "2k", "4k"]);
  });
});

describe("视频：ratio / duration 换成卡片语义", () => {
  it("seedance-2.0 面板是 时长 + 比例 + 分辨率，上游名不出现", () => {
    const { properties, defaults } = projection("bytedance/seedance-2.0-global");
    expect(properties.ratio).toBeUndefined();
    expect(properties.duration).toBeUndefined();
    expect(enumValues(properties.aspectRatio)).toContain("16:9");
    // 上游写 adaptive、卡片写 auto：面板只留一个「自适应」入口，值取上游写法。
    expect(enumValues(properties.aspectRatio)).toEqual(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
    expect(defaults).toMatchObject({ aspectRatio: "adaptive", durationSeconds: 5, resolution: "720p" });
    expect(properties.durationSeconds).toMatchObject({ type: "number", minimum: 4, maximum: 15 });
  });

  it("时长与比例提交时换回 upstream 字段，时长收敛到上游档位", () => {
    const model = findRunningHubModel("api/bytedance/seedance-2.0-global")!;
    expect(translateRunningHubParameters(model, { durationSeconds: 8, aspectRatio: "16:9", resolution: "720p" })).toEqual({
      duration: "8",
      ratio: "16:9",
      resolution: "720p"
    });
    // 自适应 → 上游的 adaptive；超范围夹到最近档位。
    expect(translateRunningHubParameters(model, { durationSeconds: 99, aspectRatio: "auto" })).toMatchObject({
      duration: "15",
      ratio: "adaptive"
    });
  });

  it("seedance-v1-lite 直接沿用上游 aspectRatio 名，时长仍是 duration", () => {
    const model = findRunningHubModel("api/seedance-v1-lite")!;
    expect(translateRunningHubParameters(model, { durationSeconds: 6, aspectRatio: "4:3" })).toMatchObject({
      duration: "6",
      aspectRatio: "4:3"
    });
  });
});


describe("刷新新发现的版本：按族规则借展示模板", () => {
  const upstream = (properties: Record<string, Record<string, unknown>>) => ({
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, ...properties } },
    defaultInput: {}
  });

  it("新版本 id 能落到同族卡片", () => {
    expect(runningHubCard("seedream-v5-flash")?.id).toBe("seedream-5.0-flash");
    expect(runningHubCard("dola-Seedream-5.0-flash")?.id).toBe("seedream-5.0-flash");
    expect(runningHubCard("seedream-v4.7")?.id).toBe("seedream-4.0");
    expect(runningHubCard("rhart-image-n-nb21-official")?.id).toBe("gemini-3.1-flash-image");
    expect(runningHubCard("bytedance/seedance-2.5-token")?.id).toBe("seedance-2.5");
    expect(runningHubCard("seedance-v1.5-pro")?.id).toBe("seedance-2.0");
    // 认不出的不硬套（超清放大不是生成模型）。
    expect(runningHubCard("bytedance/jimeng-seed3-tilesr")).toBeUndefined();
  });

  it("5.0 flash：比例 + 档位接管像素字段", () => {
    const schema = runningHubCardSchema({
      id: "seedream-v5-flash",
      outputType: "image",
      ...upstream({
        width: { type: "integer", default: 1024 },
        height: { type: "integer", default: 1024 },
        resolution: { type: "string", enum: ["1k", "1.5k", "2k"], default: "2k" }
      })
    });
    const properties = schema.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.width).toBeUndefined();
    expect(properties.aspectRatio).toBeDefined();
    expect(enumValues(properties.resolution)).toEqual(["1k", "1.5k", "2k"]);
  });

  it("nano-banana 2.1 保留 1:4 / 8:1 这类极端画幅", () => {
    const schema = runningHubCardSchema({
      id: "rhart-image-n-nb21",
      outputType: "image",
      ...upstream({
        aspectRatio: { type: "string", enum: ["1:1", "1:4", "4:1", "1:8", "8:1", "16:9"] },
        resolution: { type: "string", enum: ["1k", "2k", "4k"], default: "1k" }
      })
    });
    const properties = schema.inputSchema.properties as Record<string, Record<string, unknown>>;
    // 顺序按卡片（1:4 / 1:8 在卡片里的位置），值域是交集 + 上游多出来的。
    expect(enumValues(properties.aspectRatio)).toEqual(["1:1", "1:4", "1:8", "4:1", "8:1", "16:9"]);
    expect(enumValues(properties.resolution)).toEqual(["1k", "2k", "4k"]);
  });

  it("seedance 2.5 token：时长档位区间按上游收窄", () => {
    const schema = runningHubCardSchema({
      id: "bytedance/seedance-2.5-token",
      outputType: "video",
      ...upstream({
        duration: { type: "string", enum: ["-1", "4", "5", "6", "30"], default: "5" },
        ratio: { type: "string", enum: ["adaptive"], default: "adaptive" },
        resolution: { type: "string", enum: ["native1080p"], default: "native1080p" }
      })
    });
    const properties = schema.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.duration).toBeUndefined();
    expect(properties.durationSeconds).toMatchObject({ type: "number", minimum: 4, maximum: 30 });
    expect(enumValues(properties.aspectRatio)).toEqual(["adaptive"]);
    expect(enumValues(properties.resolution)).toEqual(["native1080p"]);
  });
});

describe("兜底与提交", () => {
  it("没有卡片映射的模型整份保持上游形状", () => {
    const { model, definition } = projection("rhart-image-g-3");
    expect(definition.inputSchema).toEqual(model.inputSchema);
    expect(translateRunningHubParameters(model, { whatever: 1 })).toEqual({ whatever: 1 });
  });

  it("prepareInput 把面板语义翻成上游字段（含媒体落点）", () => {
    const registration = createRunningHubRegistration({ apiKey: "k" });
    const prepared = registration.prepareInput!({
      providerModelId: "api/seedream-v5-lite",
      modelType: "image",
      prompt: "a cat",
      parameters: { aspectRatio: "16:9", resolution: "3k" },
      references: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" }]
    } as never) as { providerOptions: { runninghub: { input: Record<string, unknown> } } };
    expect(prepared.providerOptions.runninghub.input).toEqual({
      prompt: "a cat",
      resolution: "3k",
      width: 4096,
      height: 2304,
      imageUrls: ["https://a/1.png"]
    });
  });

  it("describeModel 返回投影后的 schema", async () => {
    const registration = createRunningHubRegistration({ apiKey: "k" });
    const described = await registration.describeModel!({ providerModelId: "api/seedream-v5-lite", modelType: "image" });
    const properties = ((described?.inputSchema ?? {}).properties ?? {}) as Record<string, unknown>;
    expect(properties.width).toBeUndefined();
    expect(properties.aspectRatio).toBeDefined();
  });
});
