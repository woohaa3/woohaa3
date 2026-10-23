/**
 * 智能对象域会话的门禁回归（U65/U66）。
 *
 * 锁定：读操作不触发 afterWrite；转回图层在有活动草稿时先拒绝、成功后只走一次 afterWrite；
 * 内核失败交给 fail 而不是假装成功刷新视图。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorHandle, type EditorFailure, type EditorInstance, type EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { createSession } from "./workspace.js";

const view: EditorViewModel = {
  hasDocument: true,
  sessionActiveIndex: null,
  document: {
    name: "art", width: 8, height: 6, mode: "Rgb", depth: 8, revision: 4, activeLayer: 4,
    selectedLayers: [4], hasSelection: false, canUndo: true, canRedo: false,
    history: ["打开"], redoHistory: [], layers: []
  } as unknown as NonNullable<EditorViewModel["document"]>
};

function fixture(instance: Partial<Record<keyof EditorInstance, unknown>>, options: { draft?: boolean; handle?: boolean } = {}) {
  const handle = new EditorHandle(instance as unknown as EditorInstance, {
    upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1
  });
  const afterWrite = vi.fn((): EditorResult<EditorViewModel> => ({ ok: true, value: view }));
  const fail = vi.fn((failure: EditorFailure): EditorResult<never> => ({
    ok: false, code: failure.code, message: failure.message
  }));
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    handle: options.handle === false ? null : handle,
    view,
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => options.draft === true,
    blockingDraft: () => (options.draft ? { ok: false, code: "stroke-active", message: "请先结算当前笔迹" } : null),
    unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未就绪" }),
    fail,
    afterWrite
  };
  return { smart: createSession(() => context), afterWrite, fail };
}

describe("智能对象域会话", () => {
  it("读取层状态与导出源不写文档、不刷新视图", () => {
    const { smart, afterWrite } = fixture({
      smartLayerStateJson: () => JSON.stringify({ layer: 4, smart: false, reason: "请先选择智能对象图层" }),
      exportSmartSource: () => ({ name: "contents.pcraft", bytes: new Uint8Array([1, 2, 3]) })
    });
    expect(smart.smartLayerState(4)).toMatchObject({ ok: true, value: { layer: 4, smart: false } });
    expect(smart.exportSmartSource(4)).toMatchObject({ ok: true, value: { name: "contents.pcraft" } });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("转回图层成功只走一次 afterWrite，返回值是新视图", () => {
    const convert = vi.fn(() => JSON.stringify({ layer: 9, group: true, layers: 2 }));
    const { smart, afterWrite, fail } = fixture({ convertSmartToLayers: convert });
    expect(smart.convertSmartToLayers(4)).toMatchObject({ ok: true, value: { hasDocument: true } });
    expect(convert).toHaveBeenCalledWith(4);
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });

  it("有活动草稿时先拒绝，不调用内核也不刷新", () => {
    const convert = vi.fn(() => JSON.stringify({ layer: 9 }));
    const { smart, afterWrite } = fixture({ convertSmartToLayers: convert }, { draft: true });
    expect(smart.convertSmartToLayers(4)).toMatchObject({ ok: false, code: "stroke-active" });
    expect(convert).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("内核拒绝时交给 fail，不刷新视图", () => {
    const { smart, afterWrite, fail } = fixture({
      convertSmartToLayers: () => { throw new Error("子文档仍在编辑中"); }
    });
    const result = smart.convertSmartToLayers(4);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("子文档仍在编辑中");
    expect(fail).toHaveBeenCalledTimes(1);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("没有内核句柄时统一返回 unavailable", () => {
    const { smart, afterWrite } = fixture({}, { handle: false });
    expect(smart.smartLayerState(4)).toMatchObject({ ok: false, code: "no-document" });
    expect(smart.exportSmartSource(4)).toMatchObject({ ok: false, code: "no-document" });
    expect(smart.convertSmartToLayers(4)).toMatchObject({ ok: false, code: "no-document" });
    expect(afterWrite).not.toHaveBeenCalled();
  });
});
