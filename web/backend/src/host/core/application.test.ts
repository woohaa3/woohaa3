import { describe, expect, it } from "vitest";
import { selectControlPlaneExtensionIds } from "./application.js";

/**
 * 控制面 catalog 的入选规则。
 *
 * 这些用例守住三个「不该出现」的行——它们都会让插件面板显示错误状态：
 * 「正在应用…」（configuring 永远不结束）、或把 Provider 当成受管扩展。
 */
describe("控制面 catalog 入选规则", () => {
  const base = {
    metadataIds: ["oauth-agent", "remote-server", "fal-provider", "hello-marketplace"],
    definitionIds: ["oauth-agent"],
    pluginIds: ["remote-server", "fal-provider"],
    declaresSiteIds: ["remote-server"]
  };

  it("有后端定义就入选，即便没有 site 段", () => {
    expect(selectControlPlaneExtensionIds(base).has("oauth-agent")).toBe(true);
  });

  it("只有 hostPlugin 时，必须同时声明 site 才入选", () => {
    const selected = selectControlPlaneExtensionIds(base);
    expect(selected.has("remote-server")).toBe(true);
    // Provider 也导出 metadata（模型目录），但没有 site 段：不进 catalog。
    expect(selected.has("fal-provider")).toBe(false);
  });

  it("纯前端扩展（既无后端定义也无 hostPlugin）不进 catalog", () => {
    // 否则控制面没有可激活的入口，状态永远停在 configuring，面板显示「正在应用…」。
    expect(selectControlPlaneExtensionIds(base).has("hello-marketplace")).toBe(false);
  });

  it("没有任何 metadata 的扩展不进 catalog", () => {
    const selected = selectControlPlaneExtensionIds({ ...base, metadataIds: [] });
    expect(selected.size).toBe(0);
  });
});
