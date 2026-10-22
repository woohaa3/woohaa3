/**
 * 站点应用插件前端入口与 browser-local 边界测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.2 / design D1/D5；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 2.1：入口升级为完整 Cordis plugin）。
 *
 * 验证：
 * - 前端 registry 拒绝代码位置字段与重复 extensionId，disposer 幂等释放；
 * - browser-local 配置不能改写站点目标（站点插件不在 browser-local allowlist，且本地解析忽略它）；
 * - 前端清单生产由扫描派生，fixture 只在测试注入。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin } from "@deepseek-ai/cordis";
import {
  ApplicationExtensionFrontendEntryRegistry,
  type ApplicationExtensionFrontendAsyncEntry
} from "./contract.js";
import { createApplicationExtensionFrontendManifest } from "./manifest.js";
import { defaultPreferences, parsePreferences } from "../services/extension-preferences/codec.js";

const plugin: Plugin = () => undefined;

const entry: ApplicationExtensionFrontendAsyncEntry = {
  metadata: {
    extensionId: "sample-site-extension",
    version: "1.0.0",
    label: "样例",
    description: "样例站点插件",
    configScope: "site",
    activation: "server-active",
    required: false,
    sdkAbi: 1
  },
  loadDescriptor: async () => ({ extensionId: "sample-site-extension", plugin: () => plugin })
};

describe("站点前端入口 registry（任务 1.2）", () => {
  it("注册 / 查询 / 幂等释放", () => {
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    const dispose = registry.register(entry);
    expect(registry.has("sample-site-extension")).toBe(true);
    expect(registry.list()).toEqual([
      { extensionId: "sample-site-extension", configScope: "site", activation: "server-active" }
    ]);
    dispose();
    dispose(); // 幂等
    expect(registry.has("sample-site-extension")).toBe(false);
  });

  it("拒绝重复 extensionId 与代码位置字段", () => {
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(entry);
    expect(() => registry.register(entry)).toThrow(/重复/);
    expect(() =>
      registry.register({ ...entry, extensionId: "other", script: "https://evil/x.js" } as never)
    ).toThrow(/代码位置/);
    expect(() => registry.register({ ...entry, metadata: {} } as never)).toThrow();
  });

  it("dispose 后不可再注册", () => {
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.dispose();
    expect(() => registry.register(entry)).toThrow(/已释放/);
  });
});

describe("站点清单与 browser-local 边界（任务 1.2）", () => {
  it("fixture 显式注入，且重复 identity 失败", () => {
    const canonical = {
      extensionId: "sample-site-extension",
      configScope: "site" as const,
      activation: "server-active" as const,
      createPlugin: () => plugin
    };
    expect(createApplicationExtensionFrontendManifest([canonical])).toHaveLength(1);
    expect(() => createApplicationExtensionFrontendManifest([canonical, canonical])).toThrow(/重复/);
    // 空 identity 失败。
    expect(() =>
      createApplicationExtensionFrontendManifest([{ ...canonical, extensionId: "" }])
    ).toThrow(/非空/);
  });

  it("browser-local 配置不能改写站点目标：站点 ID 不在 allowlist 且被忽略", () => {
    const ids = ["task-activity", "prompt-snippets", "node-history"];
    const parsed = parsePreferences(
      JSON.stringify({ ...defaultPreferences(ids), "sample-site-extension": false }),
      ids
    );
    // 站点插件 ID 被忽略，browser-local 目标不变。
    expect(parsed.preferences["sample-site-extension"]).toBeUndefined();
    expect(parsed.diagnostic?.code).toBe("unknown-ids");
    expect(parsed.preferences["task-activity"]).toBe(true);
  });

  it("前端入口源码不包含后端逻辑/网络/代码加载入口", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
      .map((entry) => path.join(dir, entry.name));
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/\bnew Function\b|\beval\s*\(/);
      expect(source, file).not.toMatch(/@woohaa3\/task-service/);
    }
  });
});
