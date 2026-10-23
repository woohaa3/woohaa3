/**
 * 本域 WASM 适配与会话的边界检查（U57–U64）。
 *
 * 只验证**适配层职责**：参数转发、响应形状核验、端口缺失与草稿门禁。
 * 真实内核语义（像素、历史、能力白名单）由 Rust 测试与真实 WASM 检查覆盖。
 */
import { expect, it, vi } from "vitest";
import * as handle from "./wasm-handle.js";
import * as workspace from "./workspace.js";
import type { FeatureHandleContext } from "../contracts.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";

const preview = { width: 2, height: 2, pixels: Array.from({ length: 16 }, () => 0) };

function context(instance: Record<string, unknown>, fail?: string): FeatureHandleContext {
  return {
    instance: instance as never,
    call<T>(run: (value: never) => T): EditorResult<T> {
      try { return { ok: true, value: run(instance as never) }; }
      catch (error) { return { ok: false, code: "command-failed", message: fail ?? String((error as Error).message ?? error) }; }
    },
  };
}

function handleFor(instance: Record<string, unknown>) {
  return handle.createHandle(() => context(instance));
}

function workspaceFor(overrides: Partial<WorkspaceFeatureContext> & { layers?: Record<string, unknown> } ) {
  const written: string[] = [];
  const afterWrite = vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: null } }));
  const contextValue = {
    handle: { features: { layers: overrides.layers ?? {} } } as never,
    hasActiveDraft: () => false,
    blockingDraft: () => null,
    afterWrite,
    unavailable: () => ({ ok: false as const, code: "unavailable", message: "编辑器不可用" }),
    fail: <T,>(failure: { code: string; message: string }) => ({ ok: false as const, ...failure }) as EditorResult<T>,
    ...overrides,
  } as unknown as WorkspaceFeatureContext;
  return { session: workspace.createSession(() => contextValue), afterWrite, written };
}

it("填充层适配器拒绝错误的命令 id 并核验预览形状", () => {
  const bridge = {
    newFillLayer: vi.fn(() => JSON.stringify({ kind: "solid", layer: 2, color: "#3366ff" })),
    fillLayerInfo: vi.fn(() => JSON.stringify({ kind: "solid", layer: 2 })),
    previewFillLayer: vi.fn(() => JSON.stringify({ info: { kind: "solid" }, preview })),
    applyFillLayer: vi.fn(() => JSON.stringify({ kind: "solid", changed: true })),
    layerWorkflow: vi.fn(() => JSON.stringify({ changed: true })),
    layerComps: vi.fn(() => JSON.stringify({ comps: [], lastApplied: null, hasLastDocumentState: false })),
    pasteRegion: vi.fn(() => JSON.stringify({ selection: [0, 0, 4, 4], clipboard: [0, 0, 4, 4], target: "pixels" })),
  };
  const adapter = handleFor(bridge);

  expect(adapter.newFillLayer("layer.newFillLayer.gradient", { from: "#000", to: "#fff" })).toMatchObject({ ok: true });
  expect(bridge.newFillLayer).toHaveBeenLastCalledWith("layer.newFillLayer.gradient", JSON.stringify({ from: "#000", to: "#fff" }));
  // 拼写错误在发出前被拒，不依赖内核返回。
  expect(adapter.newFillLayer("layer.newFillLayer.solid", {})).toMatchObject({ ok: false });
  expect(bridge.newFillLayer).toHaveBeenCalledTimes(1);

  expect(adapter.fillLayerInfo(3)).toMatchObject({ ok: true });
  expect(adapter.fillLayerInfo(-1)).toMatchObject({ ok: false });
  expect(adapter.previewFillLayer(3, { fillKind: "solid", color: "#000" })).toMatchObject({ ok: true });
  expect(adapter.applyFillLayer(3, { fillKind: "solid", color: "#000" })).toMatchObject({ ok: true });
  expect(adapter.layerComps()).toMatchObject({ ok: true });
  expect(adapter.pasteRegion()).toMatchObject({ ok: true });
});

it("预览形状不一致时视为失败，不把截断像素交给界面", () => {
  const bridge = {
    previewFillLayer: vi.fn(() => JSON.stringify({ info: { kind: "solid" }, preview: { width: 4, height: 4, pixels: [0, 0, 0, 0] } })),
    layerWorkflow: vi.fn(() => JSON.stringify({ preview: { width: 0, height: 0, pixels: [] } })),
    applyFillLayer: vi.fn(() => JSON.stringify({ kind: "solid" })),
    layerComps: vi.fn(() => JSON.stringify({ comps: new Array(65).fill({ id: 1 }) })),
  };
  const adapter = handleFor(bridge);
  expect(adapter.previewFillLayer(1, {})).toMatchObject({ ok: false });
  expect(adapter.layerWorkflow("layer.layerStyle.blendingOptions", {}, true)).toMatchObject({ ok: false });
  expect(adapter.applyFillLayer(1, {})).toMatchObject({ ok: false });
  expect(adapter.layerComps()).toMatchObject({ ok: false });
});

it("会话层在发出前拒绝越界参数，并把成功写入刷新为内容状态", () => {
  // 会话层调用的是 **handle 适配器**（`handle.features.layers`），因此替身用适配器方法名。
  const layers = {
    newFillLayer: vi.fn(() => ({ ok: true, value: { kind: "solid", layer: 1 } })),
    previewFillLayer: vi.fn(() => ({ ok: true, value: { info: {}, preview } })),
    applyFillLayer: vi.fn(() => ({ ok: true, value: { kind: "solid", changed: true } })),
    layerWorkflow: vi.fn(() => ({ ok: true, value: { changed: true } })),
    layerComps: vi.fn(() => ({ ok: true, value: { comps: [] } })),
  };
  const { session, afterWrite } = workspaceFor({ layers });

  // 图标种类与命令 id 由会话决定，面板不需要知道。
  expect(session.createFillLayer("gradient", { from: "#000", to: "#fff" })).toMatchObject({ ok: true });
  expect(layers.newFillLayer).toHaveBeenCalledWith("layer.newFillLayer.gradient", { from: "#000", to: "#fff" });
  expect(afterWrite).toHaveBeenCalledTimes(1);

  // 越界参数不进入适配层。
  expect(session.createFillLayer("gradient", { scale: 999 })).toMatchObject({ ok: false });
  expect(session.previewFillLayer(1, "solid", { color: "蓝色" })).toMatchObject({ ok: false });
  expect(layers.previewFillLayer).not.toHaveBeenCalled();
  expect(session.applyFillLayer(1, "solid", { color: "#000" })).toMatchObject({ ok: true });
  expect(layers.applyFillLayer).toHaveBeenLastCalledWith(1, { color: "#000", fillKind: "solid" });

  expect(session.previewBlending({ blendIf: { channel: "gray", thisLayer: [200, 60] } })).toMatchObject({ ok: false });
  expect(session.applyBlending({ knockout: "deepish" })).toMatchObject({ ok: false });
  expect(session.matting("layer.matting.defringe", { width: 201 }, true)).toMatchObject({ ok: false });
  expect(session.layerComp("layerComp.new", { name: "" })).toMatchObject({ ok: false });
  expect(session.layerComp("layer.delete", {})).toMatchObject({ ok: false });
});

it("草稿进行中拒绝预览与写入，端口缺失时返回统一失败", () => {
  const layers = { layerWorkflow: vi.fn() };
  const { session } = workspaceFor({ layers, hasActiveDraft: () => true, blockingDraft: () => ({ ok: false, code: "gesture-active", message: "请先结算当前草稿" }) });
  expect(session.previewBlending({})).toMatchObject({ ok: false, code: "gesture-active" });
  expect(session.matting("layer.matting.defringe", {}, false)).toMatchObject({ ok: false, code: "gesture-active" });
  expect(layers.layerWorkflow).not.toHaveBeenCalled();

  const offline = workspace.createSession(() => ({ handle: null, unavailable: () => ({ ok: false, code: "unavailable", message: "编辑器不可用" }) } as unknown as WorkspaceFeatureContext));
  expect(offline.createFillLayer("solid", { color: "#000" })).toMatchObject({ ok: false, code: "unavailable" });
  expect(offline.layerComps()).toMatchObject({ ok: false, code: "unavailable" });
});

it("复制样式与过滤只转发，不刷新内容身份", () => {
  const layers = {
    layerWorkflow: vi.fn(() => ({ ok: true, value: { changed: false, hasStyleClipboard: true } })),
    filterLayers: vi.fn(() => ({ ok: true, value: { active: true, by: "mode", layers: [], visible: 0 } })),
  };
  const { session, afterWrite } = workspaceFor({
    layers,
    handle: { features: { layers }, filterLayers: layers.filterLayers } as never,
  });
  expect(session.copyLayerStyle(4)).toMatchObject({ ok: true });
  expect(layers.layerWorkflow).toHaveBeenCalledWith("layer.layerStyle.copyLayerStyle", { layer: 4 }, false);
  expect(afterWrite).not.toHaveBeenCalled();

  expect(session.filterLayers({ by: "mode", mode: "multiply", kinds: ["raster"], onlySelected: true })).toMatchObject({ ok: true });
  expect(layers.filterLayers).toHaveBeenCalledWith({ by: "mode", mode: "multiply", kinds: ["raster"], onlySelected: true });
  expect(session.filterLayers({ kinds: ["bogus"] })).toMatchObject({ ok: false });
});

/**
 * U61：样式预设管理的适配边界。
 *
 * 预设是会话偏好：适配器必须**不**调用 `afterWrite()`（不冒充文档改动），并在形状不符时
 * 明确失败；同时只放行 `list/new/edit/reset` 四个 id。
 */
it("样式预设管理只改偏好：不刷新内容身份，形状不符即失败", () => {
  const layers = {
    stylePresets: vi.fn(() => ({ ok: true, value: { changed: false, presetsRevision: 7, presets: { groups: [] } } })),
  };
  const { session, afterWrite } = workspaceFor({ layers });

  expect(session.stylePresets("style.presets.list", {})).toMatchObject({ ok: true });
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.list", {});
  expect(afterWrite).not.toHaveBeenCalled();

  // 参数形状由协议层先挡：未知键/非法 action 不发往内核。
  expect(session.stylePresets("style.presets.list", { nope: 1 })).toMatchObject({ ok: false, code: "bad-params" });
  expect(session.stylePresets("style.presets.edit", { action: "bogus" })).toMatchObject({ ok: false, code: "bad-params" });
  expect(session.stylePresets("style.presets.apply", { preset: "x" })).toMatchObject({ ok: false, code: "bad-params" });
  expect(layers.stylePresets).toHaveBeenCalledTimes(1);
});

it("样式预设适配器核验命令 id 与响应形状", () => {
  const bridge = {
    stylePresets: vi.fn(() => JSON.stringify({ changed: false, presetsRevision: 3, presets: { groups: [] } })),
  };
  const handleApi = handleFor(bridge);
  expect(handleApi.stylePresets("style.presets.list", {})).toMatchObject({ ok: true });
  expect(bridge.stylePresets).toHaveBeenCalledWith("style.presets.list", "{}");

  // 拼错的 id 在适配器就被拒绝，不发往内核。
  expect(handleApi.stylePresets("style.presets.nope", {})).toMatchObject({ ok: false });
  expect(bridge.stylePresets).toHaveBeenCalledTimes(1);

  // 形状不符的响应（缺 presetsRevision 或 changed 非 false）同样失败。
  const bad = handleFor({ stylePresets: () => JSON.stringify({ changed: true, presetsRevision: 1 }) });
  expect(bad.stylePresets("style.presets.list", {})).toMatchObject({ ok: false });
});

/**
 * U64：复合快照是交付内容的一部分。
 *
 * 只给计数时宿主无法判断「切复合会改什么」；缺快照必须被适配器拒绝，而不是当成空快照。
 */
it("图层复合适配器要求每项带规范快照", () => {
  const withSnapshot = {
    layerComps: vi.fn(() => JSON.stringify({
      comps: [{
        id: 1, name: "显示态", layers: 2, missingLayers: [], snapshot: [
          { layer: 2, visible: true, position: null, appearance: null },
        ],
      }],
      lastApplied: 1,
      hasLastDocumentState: false,
    })),
  };
  expect(handleFor(withSnapshot).layerComps()).toMatchObject({ ok: true });

  const missing = {
    layerComps: vi.fn(() => JSON.stringify({ comps: [{ id: 1, name: "显示态", layers: 2 }] })),
  };
  expect(handleFor(missing).layerComps()).toMatchObject({ ok: false });
});

it("样式默认值命令也走偏好通道，且只放行已知 id", () => {
  const layers = {
    stylePresets: vi.fn(() => ({ ok: true, value: { changed: false, presetsRevision: 9, presets: { params: {}, user: false } } })),
  };
  const { session, afterWrite } = workspaceFor({ layers });
  expect(session.stylePresets("layer.layerStyle.defaultFor", { kind: "dropShadow" })).toMatchObject({ ok: true });
  expect(layers.stylePresets).toHaveBeenCalledWith("layer.layerStyle.defaultFor", { kind: "dropShadow" });
  expect(afterWrite).not.toHaveBeenCalled();
  // 拼错的效果名与未知键都在协议层被拒，不发往内核。
  expect(session.stylePresets("layer.layerStyle.defaultFor", {})).toMatchObject({ ok: false, code: "bad-params" });
  expect(session.stylePresets("layer.layerStyle.makeDefault", { kind: "x" })).toMatchObject({ ok: false, code: "bad-params" });
  expect(layers.stylePresets).toHaveBeenCalledTimes(1);

  const bridge = { stylePresets: vi.fn(() => JSON.stringify({ changed: false, presetsRevision: 2, presets: {} })) };
  expect(handleFor(bridge).stylePresets("layer.layerStyle.makeDefault", { kind: "dropShadow", params: {} })).toMatchObject({ ok: true });
  expect(handleFor(bridge).stylePresets("layer.layerStyle.nope", {})).toMatchObject({ ok: false });
});
