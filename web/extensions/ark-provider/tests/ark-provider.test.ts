/**
 * Ark 插件注册：目录里的模型要在对应字段填上推理接入点才出现、才可执行。
 */
import { describe, expect, it } from "vitest";
import { createArkProviderPlugin, createArkRegistration } from "../src/backend.js";
import { arkEndpointField, arkModelDefinitions, endpointsFromConfig } from "../src/shared.js";

const SEEDANCE = "doubao-seedance-2-0-260128";
const ENDPOINT = "ep-20260101000000-seedance";

describe("Ark 目录注册", () => {
  it("只有 API Key 时目录仍列出，但都不可执行", () => {
    const registration = createArkRegistration({ apiKey: "key" });
    expect(registration.available).toBe(true);
    const seedance = registration.models.find((model) => model.providerModelId === SEEDANCE);
    expect(seedance).toMatchObject({ modelType: "video", executable: false });
    expect(registration.models.every((model) => model.executable === false)).toBe(true);
  });

  it("填了接入点的模型才可执行，类型仍是视频", () => {
    const endpoints = { [SEEDANCE]: ENDPOINT };
    const registration = createArkRegistration({ apiKey: "key", endpoints });
    expect(registration.models.find((model) => model.providerModelId === SEEDANCE)).toMatchObject({
      modelType: "video",
      title: "Seedance 2.0",
      executable: true
    });
    expect(registration.models.find((model) => model.providerModelId === "doubao-seedance-2-5-260628")).toMatchObject({
      modelType: "video",
      executable: false
    });
    expect(arkModelDefinitions(endpoints).filter((model) => model.executable).map((model) => model.providerModelId)).toEqual([SEEDANCE]);
  });

  it("从每个模型自己的配置项读取接入点，非法值不挡其它模型", () => {
    const field = arkEndpointField("video", SEEDANCE);
    const parsed = endpointsFromConfig({ [field]: ENDPOINT, [arkEndpointField("image", "doubao-seedream-5-0-pro-260628")]: "not-an-endpoint" });
    expect(parsed.endpoints).toEqual({ [SEEDANCE]: ENDPOINT });
    expect(parsed.errors[0]).toMatch(/Seedream 5.0 Pro/);
  });

  it("有 Key 但没接入点时提示要填写", () => {
    const health = createArkProviderPlugin().health?.({ apiKey: "key" } as never);
    expect(health?.diagnostics[0]?.message).toMatch(/推理接入点/);
  });
});
