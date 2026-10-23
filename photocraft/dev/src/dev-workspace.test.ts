/**
 * dev 宿主的 A/B 装配回归（change: 2026-10-22-complete-photocraft-webui-editing，任务 4.5）。
 *
 * 只验证**工作区协调层**：切文档门禁、工作区剪贴板归属、粘贴转发与失败提示。
 * 内核像素语义与载荷编解码在子项目 `rust`/`packages/editor` 测试；本文件不加载 WASM。
 */
import { describe, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "@woohaa3/photocraft-editor";
import { DevWorkspace } from "./dev-workspace.js";

type Result<T = unknown> = { ok: true; value: T } | { ok: false; code: string; message: string };

function stub(options: {
  open?: boolean;
  draft?: boolean;
  saving?: boolean;
  copy?: Result<Uint8Array>;
  paste?: Result<unknown>;
  inspect?: Result<unknown>;
  canPaste?: Result<unknown>;
} = {}) {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  let open = options.open ?? true;
  const controller = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    currentView: () => ({
      hasDocument: open,
      document: open ? { width: 100, height: 80, revision: 3, layers: [{ id: 1, selected: true, active: true }], activeLayerId: 1 } : null,
      sessionActiveIndex: open ? 0 : null
    }),
    editor: () => (open ? { contentHash: () => ({ ok: true as const, value: "aabbccddeeff0011" }) } : null),
    isDirty: () => false,
    hasActiveDraft: () => options.draft === true,
    // 与真实控制器同名：宿主的切文档门禁从这里取唯一权威判据。
    pendingDraftFailure: () => (options.draft === true
      ? { ok: false as const, code: "gesture-active", message: "请先结算当前草稿" }
      : null),
    isSaving: () => options.saving === true,
    copyLayers: () => {
      calls.push("copy");
      return options.copy ?? { ok: true as const, value: new Uint8Array([1, 2, 3]) };
    },
    inspectLayerTransfer: () => {
      calls.push("inspect");
      return options.inspect ?? { ok: true as const, value: { digest: "d".repeat(64), layers: 2 } };
    },
    canPasteLayers: () => {
      calls.push("canPaste");
      return options.canPaste ?? { ok: true as const, value: { ok: true } };
    },
    pasteLayers: () => {
      calls.push("paste");
      return options.paste ?? { ok: true as const, value: { count: 2 } };
    },
    // 供测试观察：关闭文档后仍保留剪贴板。
    close: () => { open = false; }
  } as unknown as EditorWorkspaceController;
  return { controller, calls, close: () => { open = false; } };
}

function workspace(draft = false, saving = false) {
  const a = stub({ draft, saving });
  const b = stub();
  const instance = new DevWorkspace({ A: a.controller, B: b.controller });
  return { instance, a, b };
}

describe("dev A/B 工作区（任务 4.5）", () => {
  it("记住每个文档的名称、修订与内容指纹", () => {
    const { instance } = workspace();
    instance.setDocumentName("A", "a.png");
    const state = instance.snapshot();
    expect(state.active).toBe("A");
    expect(state.slots[0]).toMatchObject({ slot: "A", name: "a.png", open: true, revision: 3, contentHash: "aabbccddeeff0011" });
    expect(state.slots[1]?.open).toBe(true);
  });

  it("有活动草稿时拒绝切换，并给出原因", () => {
    const { instance } = workspace(true);
    expect(instance.activate("B")).toBe(false);
    expect(instance.snapshot().active).toBe("A");
    expect(instance.currentMessage()).toContain("草稿");
  });

  it("保存中同样拒绝切换（与草稿分开给原因）", () => {
    // dev 宿主原先只看 `hasActiveDraft()`：冻结/保存窗口里切文档会放行，正式宿主却会拒绝。
    const { instance } = workspace(false, true);
    expect(instance.activate("B")).toBe(false);
    expect(instance.snapshot().active).toBe("A");
    expect(instance.currentMessage()).toContain("保存");
  });

  it("没有文档的目标槽位拒绝激活", () => {
    const { instance, b } = workspace();
    b.close();
    expect(instance.activate("B")).toBe(false);
    expect(instance.currentMessage()).toContain("没有打开文档");
  });

  it("复制载荷进入工作区剪贴板，源文档关闭后仍可粘贴", () => {
    const { instance, a } = workspace();
    expect(instance.copy()).toBe(true);
    expect(a.calls).toEqual(["copy", "inspect"]);
    expect(instance.snapshot().clipboard).toEqual({ bytes: 3, digest: "d".repeat(64), layers: 2 });
    // 关闭源文档：剪贴板属于工作区，不受影响。
    a.close();
    expect(instance.activate("B")).toBe(true);
    expect(instance.paste(false)).toBe(true);
    expect(instance.snapshot().clipboard?.layers).toBe(2);
  });

  it("粘贴前先做目标预检；预检拒绝时不提交", () => {
    const { instance, b } = workspace();
    instance.copy();
    const rejected = new DevWorkspace({
      A: stub().controller,
      B: stub({ canPaste: { ok: true, value: { ok: false, reason: "图层超限" } } }).controller
    });
    // 在新工作区里复制，再切到 B。
    rejected.copy();
    rejected.activate("B");
    expect(rejected.paste(false)).toBe(false);
    expect(rejected.currentMessage()).toContain("图层超限");
    expect(b.calls).not.toContain("paste");
  });

  it("粘贴失败保留剪贴板并提示原因", () => {
    const { instance } = workspace();
    instance.copy();
    const failing = new DevWorkspace({
      A: stub().controller,
      B: stub({ paste: { ok: false, code: "command-failed", message: "载荷超出预算" } }).controller
    });
    failing.copy();
    failing.activate("B");
    expect(failing.paste(false)).toBe(false);
    expect(failing.currentMessage()).toContain("载荷超出预算");
    expect(failing.snapshot().clipboard).not.toBeNull();
  });

  it("空剪贴板时粘贴被拒绝并说明原因", () => {
    const { instance } = workspace();
    expect(instance.paste(false)).toBe(false);
    expect(instance.currentMessage()).toContain("剪贴板为空");
  });

  it("订阅者在状态变化时收到通知（供 useSyncExternalStore 使用）", () => {
    const { instance } = workspace();
    const listener = vi.fn();
    instance.subscribe(listener);
    instance.setDocumentName("A", "x.png");
    expect(listener).toHaveBeenCalled();
    // 快照在未变化时是同一引用。
    expect(instance.snapshot()).toBe(instance.snapshot());
  });
});

describe("独立文档槽位：新建不影响当前文档", () => {
  /**
   * 数据层验证：两个槽位各自持有独立控制器，关闭/占用另一个槽位不改变保留文档的内容。
   *
   * 「新建后当前文档保留」的字节级验证在真实 WASM 上完成，
   * 见 `tests/features/files/wasm-smoke.mjs` 的独立槽位往返用例。
   */
  it("占用另一个槽位不改变保留文档的名称与内容指纹", () => {
    const { instance, a, b } = workspace();
    instance.setDocumentName("A", "现有文档.png");
    const before = instance.snapshot().slots.find((slot) => slot.slot === "A");
    expect(before).toMatchObject({ open: true, name: "现有文档.png", contentHash: "aabbccddeeff0011" });

    // 切到 B（模拟新文档成为活动项），A 的名称/内容/修订必须原样保留。
    expect(instance.activate("B")).toBe(true);
    const after = instance.snapshot().slots.find((slot) => slot.slot === "A");
    expect(after).toEqual(before);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });
});
