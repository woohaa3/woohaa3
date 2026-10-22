/**
 * Canvas 插件清单元数据与可配置边界测试
 * （change: add-frontend-plugin-manager，任务 1.1/1.2；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6/5.1 / design D4/D6：
 *  宿主目录只含内置插件；业务 extension 由发布目录纯 metadata 在运行时注入）。
 */
import { describe, expect, it } from "vitest";
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import {
  CANVAS_PLUGIN_CATALOG,
  CONFIGURABLE_OPTIONAL_PLUGIN_IDS,
  canvasExtensionCatalogMetadata,
  createCanvasExtensionManifest,
  isConfigurableOptionalExtension,
  resolveConfigurableOptionalIds
} from "./canvas-manifest.js";

/** 发布目录派生的业务 extension 纯 metadata fixture。 */
const BROWSER_LOCAL_FIXTURES: ExtensionFrontendMetadata[] = [
  {
    extensionId: "prompt-snippets",
    version: "0.1.0",
    label: "提示词片段",
    description: "提示词片段库与插入面板。",
    activation: "browser-local",
    configScope: "browser-local",
    required: false,
    sdkAbi: 1
  },
  {
    extensionId: "task-activity",
    version: "0.1.0",
    label: "任务活动",
    description: "画布任务活动浮层。",
    activation: "browser-local",
    configScope: "browser-local",
    required: false,
    sdkAbi: 1
  }
];

const EXTENSION_METADATA_ROWS = BROWSER_LOCAL_FIXTURES.map((entry) => ({
  id: entry.extensionId,
  name: entry.label,
  description: entry.description,
  required: entry.required,
  configurable: true
}));

describe("Canvas 插件清单契约（任务 1.1）", () => {
  it("stable ID 与顺序唯一，元数据完整", () => {
    const metadata = canvasExtensionCatalogMetadata();
    const ids = metadata.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of metadata) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.name.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.description.trim().length, entry.id).toBeGreaterThan(0);
      expect(typeof entry.required).toBe("boolean");
      expect(typeof entry.configurable).toBe("boolean");
    }
  });

  it("宿主内置 allowlist 只含 node-history；browser-local optional 由运行时合并", () => {
    expect([...CONFIGURABLE_OPTIONAL_PLUGIN_IDS]).toEqual(["node-history"]);
    expect(resolveConfigurableOptionalIds(["task-activity", "prompt-snippets"])).toEqual([
      "node-history",
      "prompt-snippets",
      "task-activity"
    ]);
    for (const entry of canvasExtensionCatalogMetadata()) {
      expect(entry.configurable, entry.id).toBe(isConfigurableOptionalExtension(entry.id));
      if (entry.configurable) expect(entry.required, entry.id).toBe(false);
    }
  });

  it("合并运行时发布目录 metadata 后，browser-local optional 可配置且 required=false", () => {
    const metadata = canvasExtensionCatalogMetadata(EXTENSION_METADATA_ROWS);
    for (const entry of metadata) {
      if (entry.id === "prompt-snippets" || entry.id === "task-activity") {
        expect(entry.configurable, entry.id).toBe(true);
        expect(entry.required, entry.id).toBe(false);
      }
    }
    // 跨来源 stable ID 唯一。
    const ids = metadata.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("manifest 与目录顺序一致且每个定义携带元数据", () => {
    const manifest = createCanvasExtensionManifest();
    expect(manifest.map((definition) => definition.id)).toEqual(
      canvasExtensionCatalogMetadata().map((entry) => entry.id)
    );
    for (const definition of manifest) {
      expect(definition.name).toBeTruthy();
      expect(definition.description).toBeTruthy();
    }
  });

  it("paste-import/model-editor/plugin-manager 是 required（任务 1.2）", () => {
    const manifest = createCanvasExtensionManifest();
    for (const id of ["paste-import", "model-editor", "extension-manager"]) {
      const definition = manifest.find((entry) => entry.id === id);
      expect(definition?.required, id).toBe(true);
      expect(definition?.configurable, id).not.toBe(true);
    }
  });

  it("目录只静态 import 插件（无动态 create 入口接受模块名）", () => {
    for (const entry of CANVAS_PLUGIN_CATALOG) {
      expect(typeof entry.create).toBe("function");
    }
  });

  it("跨来源（内置 + 发布目录扩展）stable ID 唯一（任务 2.2）", () => {
    const definition = {
      id: "prompt-snippets",
      required: false,
      configurable: true,
      name: "提示词片段",
      description: "提示词片段库与插入面板。",
      plugin: (() => undefined) as never
    };
    const manifest = createCanvasExtensionManifest({ extensions: [definition] });
    const ids = manifest.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((entry) => entry === "prompt-snippets")).toHaveLength(1);
    expect(() =>
      createCanvasExtensionManifest({ extensions: [definition, definition] })
    ).toThrow(/重复/);
  });
});
