import { describe, expect, it, vi } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas, prepareModelResource } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "./composite-assets.js";
const adapter = (identity: string) => ({ extensionId: identity, owner: identity, executionKey: () => "static", prepare: () => ({ resource: prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: [] }) }) });
describe("复合资产严格 owner 与 scope", () => {
  it("节点级形状通过共享 mapper 派生 ground，矩形角色保留原范围且不回写尺寸", () => {
    const registry = new CompositeAssetRegistry();
    registry.register({ ...adapter("test-asset"), scopeShape: "rect", scopeShapeForNode: id => id === "main" ? "isometric-diamond" : "rect" });
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    for (const id of ["main", "input"]) {
      canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 10, y: 20 }, width: 260, height: 195 });
      canvas.nodeData[id] = { extensionId: "test-asset" } as never;
    }
    const before = JSON.stringify(canvas);
    const scene = buildCanvasRenderScene({ canvas, compositeAssetScopeShapes: registry.scopeShapes(canvas) });
    expect(scene.nodes.find(node => node.id === "main")?.compositeAsset).toMatchObject({ scopeShape: "isometric-diamond", scopeGround: expect.any(Object) });
    expect(scene.nodes.find(node => node.id === "input")?.compositeAsset).not.toHaveProperty("scopeGround");
    expect(JSON.stringify(canvas)).toBe(before);
  });
  it("逐节点覆盖静态形状，undefined 恢复静态声明，坏节点不阻断其它节点", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new CompositeAssetRegistry();
      let broken = false;
      let useDefault = false;
      registry.register({ ...adapter("test-asset"), scopeShape: "rect", scopeShapeForNode: id => {
        if (id === "main") { if (broken) throw new Error("unavailable"); return useDefault ? undefined : "isometric-diamond"; }
        if (id === "bad") return "hexagon" as never;
        return undefined;
      } });
      const canvas = createEmptyWoohaa3ServerCanvas("c");
      for (const id of ["main", "bad", "input"]) {
        canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 0, y: 0 } });
        canvas.nodeData[id] = { extensionId: "test-asset", extensionContentRef: { schemaVersion: 1, instanceId: "one" } } as never;
      }
      expect([...registry.scopeShapes(canvas)]).toEqual([["main", "isometric-diamond"], ["bad", "rect"], ["input", "rect"]]);
      expect(registry.scopeDiagnostic("bad")).toContain("hexagon");
      broken = true;
      expect(registry.scopeShapes(canvas).get("main")).toBe("isometric-diamond");
      expect(registry.scopeDiagnostic("main")).toBe("unavailable");
      registry.scopeShapes(canvas);
      expect(warning).toHaveBeenCalledTimes(2);
      broken = false; useDefault = true;
      expect(registry.scopeShapes(canvas).get("main")).toBe("rect");
      expect(registry.scopeDiagnostic("main")).toBeNull();
    } finally { warning.mockRestore(); }
  });
  it("范围回退按画布/内容引用隔离，删除、卸载和 clear 清理诊断及历史", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new CompositeAssetRegistry();
      let broken = false;
      const definition = { ...adapter("test-asset"), scopeShapeForNode: () => { if (broken) throw new Error("unavailable"); return "rect" as const; } };
      let stop = registry.register(definition);
      const canvas = createEmptyWoohaa3ServerCanvas("c");
      canvas.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
      canvas.nodeData.node = { extensionId: "test-asset", extensionContentRef: { schemaVersion: 1, instanceId: "one" } } as never;
      const seed = () => { broken = false; expect(registry.scopeShapes(canvas).get("node")).toBe("rect"); broken = true; };
      seed();
      canvas.nodeData.node.extensionContentRef = { schemaVersion: 1, instanceId: "two" };
      expect(registry.scopeShapes(canvas).has("node")).toBe(false);
      seed(); canvas.id = "other";
      expect(registry.scopeShapes(canvas).has("node")).toBe(false);
      seed(); registry.retain(new Set());
      expect(registry.scopeDiagnostic("node")).toBeNull();
      expect(registry.scopeShapes(canvas).has("node")).toBe(false);
      seed(); stop(); stop = registry.register(definition);
      expect(registry.scopeShapes(canvas).has("node")).toBe(false);
      seed(); registry.clear(); registry.register(definition);
      expect(registry.scopeShapes(canvas).has("node")).toBe(false);
      registry.scopeShapes(null);
      expect(registry.scopeDiagnostic("node")).toBeNull();
      stop();
    } finally { warning.mockRestore(); }
  });
  it("只能由 type + extensionId 解析，不能由 payload 或标题猜业务", () => {
    const registry = new CompositeAssetRegistry();
    registry.register(adapter("film-set"));
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "asset", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.asset = { title: "片场", filmSetContent: { schemaVersion: 3, items: [] } } as never;
    expect(registry.resolve(canvas, "asset")).toBeNull();
    canvas.nodeData.asset.extensionId = "film-set";
    expect(registry.resolve(canvas, "asset")?.extensionId).toBe("film-set");
    canvas.document.nodes[0]!.type = "model3d";
    expect(registry.resolve(canvas, "asset")).toBeNull();
  });
  it("拒绝冲突并让重复释放无副作用，释放移除所属资源投影", () => {
    const registry = new CompositeAssetRegistry();
    const stop = registry.register(adapter("asset-a"));
    expect(() => registry.register(adapter("asset-a"))).toThrow("冲突");
    expect(() => registry.register({ ...adapter("asset-b"), owner: "asset-a" })).toThrow("不一致");
    registry.setProjection("node", adapter("asset-a").prepare(), "asset-a");
    const generation = registry.generation("asset-a");
    stop(); stop();
    expect(registry.generation("asset-a")).toBe(generation + 1);
    expect(registry.projection("node")).toBeNull();
  });
  it("同名节点在两个 scope 之间不共享资源、adapter 或键盘门禁", () => {
    const first = new CompositeAssetRegistry(), second = new CompositeAssetRegistry();
    first.register({ ...adapter("test-asset"), blocksFocusInput: () => true });
    first.setProjection("same-node", adapter("test-asset").prepare(), "test-asset");
    expect(first.blocksFocusInput()).toBe(true);
    expect(second.blocksFocusInput()).toBe(false);
    expect(second.projection("same-node")).toBeNull();
  });
  it("范围形状为类别默认：无声明即不覆盖，仅为显式覆盖（如 rect）写入；未知值在 register 拒绝", () => {
    // change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3 修订。
    const registry = new CompositeAssetRegistry();
    registry.register(adapter("film-set"));
    registry.register({ ...adapter("rect-asset"), scopeShape: "rect" });
    expect(() => registry.register({ ...adapter("bad-asset"), scopeShape: "hexagon" as never })).toThrow("未知");
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "rect", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.film = { extensionId: "film-set" } as never;
    canvas.nodeData.rect = { extensionId: "rect-asset" } as never;
    const shapes = registry.scopeShapes(canvas);
    // 片场未覆盖：不写入，即使用类别默认等距范围。
    expect(shapes.has("film")).toBe(false);
    // 显式覆盖为 rect 才写入。
    expect(shapes.get("rect")).toBe("rect");
  });
  it("业务类型名按严格身份从 adapter label 解析，未声明或非复合资产不写入", () => {
    // change: 2026-10-12-align-film-set-scope-with-isometric-grid。
    const registry = new CompositeAssetRegistry();
    registry.register({ ...adapter("film-set"), label: "片场" });
    registry.register({ ...adapter("plain-asset") });
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "plain", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 0, y: 0 } });
    canvas.nodeData.film = { extensionId: "film-set" } as never;
    canvas.nodeData.plain = { extensionId: "plain-asset" } as never;
    const labels = registry.typeLabels(canvas);
    expect(labels.get("film")).toBe("片场");
    // 未声明 label 的业务不写入，mapper 回落通用内容类型标签。
    expect(labels.has("plain")).toBe(false);
    expect(labels.has("img")).toBe(false);
  });
  it("总览 LOD 策略仅由显式声明的 adapter 写入；未知值在 register 拒绝；撤回后失效", () => {
    // change: 2026-10-15-add-film-set-overview-lod，design D1。
    const registry = new CompositeAssetRegistry();
    registry.register({ ...adapter("film-set"), geometryQuality: "overview-primitives-v1" });
    registry.register({ ...adapter("furnace") });
    const stop = registry.register({ ...adapter("third-party"), geometryQuality: "overview-primitives-v1" });
    expect(() => registry.register({ ...adapter("bad"), geometryQuality: "overview-primitives-v2" as never })).toThrow("未知");
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "furnace", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "third", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 0, y: 0 } });
    canvas.nodeData.film = { extensionId: "film-set" } as never;
    canvas.nodeData.furnace = { extensionId: "furnace" } as never;
    canvas.nodeData.third = { extensionId: "third-party" } as never;
    // 只有显式声明才写入；炉体/普通内容/非复合资产不写入（World 保持 High）。
    expect(registry.geometryQualities(canvas).get("film")).toBe("overview-primitives-v1");
    expect(registry.geometryQualities(canvas).get("third")).toBe("overview-primitives-v1");
    expect(registry.geometryQualities(canvas).has("furnace")).toBe(false);
    expect(registry.geometryQualities(canvas).has("img")).toBe(false);
    // 撤回声明：generation 变化 + 不再写入，宿主下一帧恢复高质（design D1）。
    const generation = registry.generation("third-party");
    stop();
    expect(registry.generation("third-party")).toBe(generation + 1);
    expect(registry.geometryQualities(canvas).has("third")).toBe(false);
  });
  it("声明 geometryQuality 不改变执行 key（内容身份与策略分离）", () => {
    // change: 2026-10-15-add-film-set-overview-lod，design D1：只进呈现协议。
    const registry = new CompositeAssetRegistry();
    registry.register({ ...adapter("film-set"), geometryQuality: "overview-primitives-v1" });
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.film = { extensionId: "film-set", contentRevision: 7 } as never;
    const resolved = registry.resolve(canvas, "film");
    // executionKey 只读内容，与 geometryQuality 声明无关。
    expect(resolved?.executionKey(canvas.nodeData.film)).toBe("static");
  });
});
