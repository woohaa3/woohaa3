/**
 * Extension 启动选择测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 5.1/5.8 / design D8）。
 *
 * 验证在创建 scope 前只依赖纯 metadata：always/required 必选、server-active 只登记不加载、
 * browser-local optional 按本地偏好选择、禁用不进入加载集合。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { resolveExtensionStartupSelection, configurableBrowserLocalIds } from "./selection.js";

function metadata(overrides: Partial<ExtensionFrontendMetadata> & Pick<ExtensionFrontendMetadata, "extensionId">): ExtensionFrontendMetadata {
  return {
    version: "0.1.0",
    label: overrides.extensionId,
    description: overrides.extensionId,
    activation: "browser-local",
    configScope: "browser-local",
    required: false,
    sdkAbi: 1,
    ...overrides
  };
}

const ALWAYS = metadata({ extensionId: "chatgpt", activation: "always", configScope: "site", required: true });
const SERVER = metadata({ extensionId: "game-furnace", activation: "server-active", configScope: "site" });
const LOCAL = metadata({ extensionId: "prompt-snippets", activation: "browser-local", configScope: "browser-local" });

describe("resolveExtensionStartupSelection", () => {
  it("always/required 进入加载集合；server-active 只登记；本地已启用 optional 加载", () => {
    const result = resolveExtensionStartupSelection({
      metadata: [ALWAYS, SERVER, LOCAL],
      desired: { "prompt-snippets": true }
    });
    expect(result.load.map((entry) => entry.extensionId)).toEqual(["chatgpt", "prompt-snippets"]);
    expect(result.registered.map((entry) => entry.extensionId)).toEqual(["game-furnace"]);
    expect(result.disabledIds).toEqual([]);
    expect(result.requiredIds).toEqual(["chatgpt"]);
    expect(result.assembled).toEqual({ "prompt-snippets": true });
  });

  it("本地禁用 optional：不进入 load，记录 disabled", () => {
    const result = resolveExtensionStartupSelection({
      metadata: [ALWAYS, SERVER, LOCAL],
      desired: { "prompt-snippets": false }
    });
    expect(result.load.some((entry) => entry.extensionId === "prompt-snippets")).toBe(false);
    expect(result.disabledIds).toEqual(["prompt-snippets"]);
    expect(result.assembled).toEqual({ "prompt-snippets": false });
  });

  it("缺失偏好默认启用（升级行为不变）", () => {
    const result = resolveExtensionStartupSelection({ metadata: [LOCAL], desired: {} });
    expect(result.load.map((entry) => entry.extensionId)).toEqual(["prompt-snippets"]);
  });

  it("本地偏置不能禁用 required/always", () => {
    const result = resolveExtensionStartupSelection({
      metadata: [ALWAYS],
      desired: { chatgpt: false }
    });
    expect(result.load.map((entry) => entry.extensionId)).toEqual(["chatgpt"]);
    expect(result.disabledIds).toEqual([]);
  });

  it("configurableBrowserLocalIds 只取 browser-local 且非 required", () => {
    expect(configurableBrowserLocalIds([ALWAYS, SERVER, LOCAL])).toEqual(["prompt-snippets"]);
  });
});
