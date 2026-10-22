/**
 * group 叶子展开与模型身份解析测试
 * （change: add-canvas-node-grouping，任务 3.3；change: 2026-10-16-add-group-selection-toolbar，任务 1.1）。
 *
 * 非渲染回归：只测两个共享纯函数——成员关系递归展开与目录模型回落。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { collectGroupLeafDescendants, resolveCatalogModelKey } from "./group-leaf-resolution.js";

describe("collectGroupLeafDescendants", () => {
  it("递归展开非 group 后代（parentId 是唯一事实源）", () => {
    const nodes = [
      { id: "g1", type: "group" },
      { id: "g2", type: "group", parentId: "g1" },
      { id: "a", type: "image", parentId: "g2" },
      { id: "b", type: "text", parentId: "g1" },
      { id: "outside", type: "image" }
    ];
    expect(collectGroupLeafDescendants(nodes, "g1").sort()).toEqual(["a", "b"]);
  });

  it("无成员时返回空数组", () => {
    expect(collectGroupLeafDescendants([{ id: "g", type: "group" }], "g")).toEqual([]);
  });

  it("parent 环不导致无限循环", () => {
    const nodes = [
      { id: "g1", type: "group", parentId: "g2" },
      { id: "g2", type: "group", parentId: "g1" },
      { id: "a", type: "image", parentId: "g1" }
    ];
    expect(collectGroupLeafDescendants(nodes, "g1")).toEqual(["a"]);
  });
});

describe("resolveCatalogModelKey", () => {
  const model = (key: string, type: string) => ({ modelKey: key, modelType: type });
  const taskCatalog = {
    available: true,
    models: [model("img-default", "image"), model("img-alt", "image"), model("txt-1", "language")],
    defaultModels: { image: "img-default" }
  } as unknown as CanvasTaskCatalog;

  it("合法显式选择原样保留", () => {
    expect(resolveCatalogModelKey(taskCatalog, "image", "img-alt")).toBe("img-alt");
  });

  it("非法或空选择回落到 defaultModels", () => {
    expect(resolveCatalogModelKey(taskCatalog, "image", "nope")).toBe("img-default");
    expect(resolveCatalogModelKey(taskCatalog, "image", "")).toBe("img-default");
  });

  it("defaultModels 不合法时回落到该类型第一个模型", () => {
    const catalog = {
      available: true,
      models: [model("txt-1", "language")],
      defaultModels: { language: "missing" }
    } as unknown as CanvasTaskCatalog;
    expect(resolveCatalogModelKey(catalog, "language", "")).toBe("txt-1");
  });

  it("目录不可用时原样退回显式值（由提交预检报错）", () => {
    const catalog = { available: false, models: [], defaultModels: {} } as unknown as CanvasTaskCatalog;
    expect(resolveCatalogModelKey(catalog, "image", "user-pick")).toBe("user-pick");
  });
});
