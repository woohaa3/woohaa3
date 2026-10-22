/**
 * 启动选择器测试
 * （change: add-frontend-plugin-manager，任务 2.3/3.1）。
 */
import { describe, expect, it } from "vitest";
import { sourceCanvasCatalogMetadata } from "../../test-support/source-extensions.js";
import { resolveStartupSelection, isAssembledAtStartup } from "./selector.js";
import { defaultPreferences } from "./codec.js";
import { hasPendingExtensionChanges, projectExtensionManagerRows } from "../../plugins/extension-manager/projection.js";

const CATALOG = sourceCanvasCatalogMetadata();
const IDS = CATALOG.filter((entry) => entry.configurable).map((entry) => entry.id);

describe("启动选择器（任务 3.1）", () => {
  it("默认全启用时装配全部 configurable optional", () => {
    const snapshot = resolveStartupSelection(CATALOG, defaultPreferences(IDS));
    expect(snapshot.disabledIds).toEqual([]);
    expect(Object.values(snapshot.assembled)).toEqual(IDS.map(() => true));
  });

  it("禁用时记录 disabled ID 且不再装配", () => {
    const snapshot = resolveStartupSelection(CATALOG, { ...defaultPreferences(IDS), "node-history": false });
    expect(snapshot.disabledIds).toEqual(["node-history"]);
    expect(snapshot.assembled["node-history"]).toBe(false);
  });

  it("required 定义恒为装配（即使配置为禁用）", () => {
    const definition = { id: "paste-import", required: true, configurable: false };
    const snapshot = resolveStartupSelection(CATALOG, { ...defaultPreferences(IDS), "paste-import": false } as never);
    expect(isAssembledAtStartup(definition, snapshot.assembled)).toBe(true);
  });

  it("configurable optional 依据 startup snapshot 决定装配", () => {
    const snapshot = resolveStartupSelection(CATALOG, { ...defaultPreferences(IDS), "prompt-snippets": false });
    expect(
      isAssembledAtStartup({ id: "prompt-snippets", required: false, configurable: true }, snapshot.assembled)
    ).toBe(false);
  });
});

describe("Plugin Manager 行投影（任务 2.3）", () => {
  const assembled = { "prompt-snippets": true, "node-history": false };

  it("只包含可配置 optional 行，required 不出现", () => {
    const rows = projectExtensionManagerRows(CATALOG, { assembled, desired: assembled });
    expect(rows.every((row) => row.configurable && !row.required)).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(["node-history", "prompt-snippets"]);
    expect(rows.some((row) => row.id === "paste-import" || row.id === "model-editor")).toBe(false);
  });

  it("目标与启动一致：enabled→active，disabled→disabled", () => {
    const rows = projectExtensionManagerRows(CATALOG, { assembled, desired: assembled });
    expect(rows.find((row) => row.id === "prompt-snippets")?.status).toBe("active");
    expect(rows.find((row) => row.id === "node-history")?.status).toBe("disabled");
  });

  it("关闭已装配的 optional → pending-disable", () => {
    const rows = projectExtensionManagerRows(CATALOG, {
      assembled,
      desired: { ...assembled, "prompt-snippets": false }
    });
    expect(rows.find((row) => row.id === "prompt-snippets")?.status).toBe("pending-disable");
  });

  it("启用未装配的 optional → pending-enable", () => {
    const rows = projectExtensionManagerRows(CATALOG, {
      assembled,
      desired: { ...assembled, "node-history": true }
    });
    expect(rows.find((row) => row.id === "node-history")?.status).toBe("pending-enable");
  });

  it("启动失败但有目标启用 → failed（目标开关仍为启用）", () => {
    const rows = projectExtensionManagerRows(CATALOG, {
      assembled,
      desired: assembled,
      failed: new Set(["prompt-snippets"])
    });
    expect(rows.find((row) => row.id === "prompt-snippets")?.status).toBe("failed");
  });

  it("切回启动值后无 pending", () => {
    expect(hasPendingExtensionChanges(CATALOG, { assembled, desired: { ...assembled, "prompt-snippets": false } })).toBe(
      true
    );
    expect(hasPendingExtensionChanges(CATALOG, { assembled, desired: assembled })).toBe(false);
  });
});
