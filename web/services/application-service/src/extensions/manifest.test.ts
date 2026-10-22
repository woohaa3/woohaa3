/**
 * Task 后端插件可信清单测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.2）。
 */
import { describe, expect, it } from "vitest";
import {
  APPLICATION_BACKEND_EXTENSION_MANIFEST,
  createApplicationBackendExtensionManifest,
  validateApplicationBackendExtensionManifest
} from "./manifest.js";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

const sample: ApplicationBackendExtensionDefinition = {
  extensionId: "sample-site-extension",
  requiredDependencies: ["task-runtime"],
  capabilities: [{ id: "sample.action", kind: "handler", description: "样例", auth: "authenticated" }],
  activate: () => ({})
};

describe("Task 后端插件清单（任务 1.2）", () => {
  it("无目录宿主默认不装配业务扩展", () => {
    expect(APPLICATION_BACKEND_EXTENSION_MANIFEST.map(entry => entry.extensionId)).not.toContain(sample.extensionId);
    const manifest = createApplicationBackendExtensionManifest();
    expect(manifest.definitions).toEqual([]);
  });

  it("重复 extensionId 稳定拒绝", () => {
    expect(validateApplicationBackendExtensionManifest([sample, sample]).ok).toBe(false);
    expect(() => createApplicationBackendExtensionManifest([sample, sample])).toThrow();
  });

  it("测试可注入 fixture 而不污染生产清单", () => {
    const fixture = createApplicationBackendExtensionManifest([sample]);
    expect(fixture.definitions.map((entry) => entry.extensionId)).toEqual(["sample-site-extension"]);
    expect(APPLICATION_BACKEND_EXTENSION_MANIFEST.map(entry => entry.extensionId)).not.toContain(sample.extensionId);
  });
});
