/**
 * Ark 插件注册：目录里的模型要在对应字段填上推理接入点才出现、才可执行。
 */
import { describe, expect, it } from "vitest";
import { createArkProviderPlugin, createArkRegistration } from "../src/backend.js";
import { arkEndpointField, arkModelDefinitions, endpointsFromConfig } from "../src/shared.js";

const SEEDANCE = "doubao-seedance-2-0-260128";
const ENDPOINT = "ep-20260101000000-seedance";

describe("Ark 目录注册", () => {
  it("只配 API Key 时模型就可执行（公开 Model ID 可直接调用）", () => {
    const registration = createArkRegistration({ apiKey: "key" });
    expect(registration.available).toBe(true);
    const seedance = registration.models.find((model) => model.providerModelId === SEEDANCE);
    expect(seedance).toMatchObject({ modelType: "video", executable: true });
    // 推理接入点不是准入门槛：没填也全部可执行。
    expect(registration.models.every((model) => model.executable === true)).toBe(true);
  });

  it("填接入点只是覆盖请求里的 model，不影响可执行性与模型类型", () => {
    const endpoints = { [SEEDANCE]: ENDPOINT };
    const registration = createArkRegistration({ apiKey: "key", endpoints });
    expect(registration.models.find((model) => model.providerModelId === SEEDANCE)).toMatchObject({
      modelType: "video",
      title: "Seedance 2.0",
      executable: true
    });
    expect(registration.models.find((model) => model.providerModelId === "doubao-seedance-2-5-260628")).toMatchObject({
      modelType: "video",
      executable: true
    });
    // 全部模型都可执行，不再只有填了接入点的那几个。
    expect(arkModelDefinitions(endpoints).filter((model) => model.executable).length).toBe(
      registration.models.length
    );
  });

  it("从每个模型自己的配置项读取接入点，非法值不挡其它模型", () => {
    const field = arkEndpointField("video", SEEDANCE);
    const parsed = endpointsFromConfig({ [field]: ENDPOINT, [arkEndpointField("image", "doubao-seedream-5-0-pro-260628")]: "not-an-endpoint" });
    expect(parsed.endpoints).toEqual({ [SEEDANCE]: ENDPOINT });
    expect(parsed.errors[0]).toMatch(/Seedream 5.0 Pro/);
  });

  it("有 Key 且接入点留空时不再报降级", () => {
    const health = createArkProviderPlugin().health?.({ apiKey: "key" } as never);
    expect(health).toBeUndefined();
  });

  it("没配 Key 时降级并说明原因", () => {
    const health = createArkProviderPlugin().health?.({ apiKey: "" } as never);
    expect(health?.state).toBe("degraded");
    expect(health?.diagnostics[0]?.message).toMatch(/API Key/);
  });
});
