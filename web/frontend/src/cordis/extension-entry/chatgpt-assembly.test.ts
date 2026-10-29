/**
 * 常驻（always/required）extension 装配边界验收
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.4/5.5；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6/5.1：
 *  宿主不再构建期扫描 extension 源码。always/required 业务入口（ChatGPT、片场）由发布目录纯
 *  metadata 在运行时派生，加载 descriptor 后进入 Canvas 常驻 kernel 清单；不由 server-active
 *  reconciler 装配（避免双重 owner）。
 *
 *  宿主构建不导入任何 extension 业务源码，因此本测试只验证宿主边界：内置目录不含业务条目、
 *  运行时注入的 always/required 定义进入清单、reconciler 不拥有常驻入口。
 *
 * @vitest-environment node
 */
import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import type { ApplicationExtensionStatus, ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { createCanvasExtensionManifest, CANVAS_PLUGIN_CATALOG } from "../canvas-manifest.js";
import { ApplicationExtensionFrontendEntryRegistry } from "./contract.js";
import { createApplicationExtensionEntryReconciler } from "./reconciler.js";

function status(extensionId: string, actualState: ApplicationExtensionStatus["actualState"]): ApplicationExtensionStatus {
  return {
    extensionId,
    desiredEnabled: actualState === "active",
    actualState,
    configVersion: 1,
    extensionRevision: 1,
    activeWorkCount: 0,
    diagnostics: []
  };
}

const RESIDENT_METADATA: ExtensionFrontendMetadata = {
  extensionId: "resident-extension",
  version: "0.1.0",
  label: "常驻扩展",
  description: "代表 always/required 业务入口（如 ChatGPT、片场）。",
  activation: "always",
  configScope: "site",
  required: true,
  sdkAbi: 1
};

const BUSINESS_IDS = [
  "oauth-agent",
  "film-set",
  "runninghub-provider",
  "prompt-snippets",
  "task-activity"
];

describe("常驻 extension 装配边界（任务 5.4）", () => {
  it("宿主内置目录不含任何业务 extension；业务条目只在运行时注入", () => {
    const builtin = createCanvasExtensionManifest();
    for (const id of BUSINESS_IDS) {
      expect(builtin.find((definition) => definition.id === id)).toBeUndefined();
      expect(CANVAS_PLUGIN_CATALOG.find((entry) => entry.id === id)).toBeUndefined();
    }
  });

  it("运行时注入的 always/required 定义进入常驻清单，且 required 标记保留", () => {
    const plugin: Plugin = () => undefined;
    const definition = {
      id: RESIDENT_METADATA.extensionId,
      required: RESIDENT_METADATA.required,
      configurable: false,
      name: RESIDENT_METADATA.label,
      description: RESIDENT_METADATA.description,
      plugin
    };
    const manifest = createCanvasExtensionManifest({ extensions: [definition] });
    const entry = manifest.find((item) => item.id === RESIDENT_METADATA.extensionId);
    expect(entry?.required).toBe(true);
    expect(entry?.plugin).toBe(plugin);
  });

  it("reconciler 不装配 always 入口（避免与 kernel 清单双重 owner）", async () => {
    const ctx = new Context();
    let applied = 0;
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: RESIDENT_METADATA,
      async loadDescriptor() {
        return {
          extensionId: RESIDENT_METADATA.extensionId,
          plugin: () => () => {
            applied += 1;
          }
        };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status(RESIDENT_METADATA.extensionId, "active")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applied).toBe(0);
    expect(reconciler.activeExtensionIds()).toEqual([]);
    await reconciler.dispose();
  });
});
