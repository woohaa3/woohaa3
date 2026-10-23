import { afterEach, expect, it, vi } from "vitest";
import { TextSession, type TextDraft } from "../../text-session.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";

afterEach(() => vi.unstubAllGlobals());
const draft: TextDraft = { text: "中文", font: "Noto Sans SC", size: 48, color: "#000000", fauxBold: false, align: "left" };
function setup() {
  let next = 0;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return ++next; }));
  // 故意保留已取消回调，以验证输入法、取消和后续会话均隔离迟到帧。
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const controller = {
    beginText: vi.fn((_params: unknown) => ({ ok: true, value: { text: "", new: true } })),
    previewText: vi.fn((_params: unknown) => ({ ok: true, value: { text: "中文" } } as { ok: true; value: unknown } | { ok: false; message: string; code: string })),
    commitText: vi.fn(() => ({ ok: true, value: {} })), cancelText: vi.fn()
  };
  const refresh = vi.fn(), error = vi.fn(), info = vi.fn();
  const session = new TextSession(controller as unknown as EditorWorkspaceController, refresh, error, info);
  return { session, controller, refresh, error, info, frames };
}

it("按帧合并内容和样式，确认补齐尾部预览后仅提交一次", () => {
  const { session, controller, frames, info } = setup();
  expect(session.begin({ x: 10, y: 20, box: [10, 20, 80, 50] })).toBe(true);
  expect(session.begin({ layer: 1 })).toBe(false);
  session.preview(draft); session.preview({ ...draft, size: 36 });
  expect(controller.previewText).not.toHaveBeenCalled();
  expect(frames).toHaveLength(1); frames[0](0);
  expect(controller.previewText).toHaveBeenCalledOnce();
  expect(controller.previewText).toHaveBeenCalledWith({ ...draft, size: 36 });
  session.preview({ ...draft, text: "最后输入" });
  expect(session.commit()).toBe(true);
  expect(controller.previewText).toHaveBeenLastCalledWith({ ...draft, text: "最后输入" });
  expect(controller.commitText).toHaveBeenCalledOnce();
  frames[1](0);
  expect(controller.previewText).toHaveBeenCalledTimes(2);
  expect(info).toHaveBeenCalledTimes(3);
  expect(session.commit()).toBe(false);
});

it("输入法组合取消旧帧，预编辑文字仍预览，但确认要等选词结束", () => {
  const { session, controller, frames, error } = setup();
  session.begin({ layer: 2 }); session.preview(draft);
  session.compositionStart(); frames[0](0);
  session.preview({ ...draft, text: "zhong" });
  frames[1](0);
  expect(session.commit()).toBe(false);
  expect(controller.previewText).toHaveBeenCalledWith({...draft,text:"zhong"});
  expect(controller.commitText).not.toHaveBeenCalled();
  expect(error).toHaveBeenLastCalledWith("请先完成输入法选词，再确认文字");
  session.compositionEnd({ ...draft, text: "中" });
  expect(frames).toHaveLength(3); frames[2](0);
  expect(controller.previewText).toHaveBeenCalledTimes(2);
  expect(controller.previewText).toHaveBeenCalledWith({ ...draft, text: "中" });
  expect(session.commit()).toBe(true);
});

it("取消清除组合与草稿，旧帧不能消费新会话或恢复输入", () => {
  const { session, controller, frames, refresh } = setup();
  session.begin({ x: 1, y: 2 }); session.preview(draft); session.cancel();
  session.preview(draft); session.compositionEnd(draft);
  expect(controller.cancelText).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
  session.begin({ layer: 3 }); session.preview({ ...draft, text: "新会话" });
  frames[0](0);
  expect(controller.previewText).not.toHaveBeenCalled();
  frames[1](0);
  expect(controller.previewText).toHaveBeenCalledOnce();
  expect(controller.previewText).toHaveBeenCalledWith({ ...draft, text: "新会话" });
});

it("预览失败阻止确认旧草稿，修正输入后可重试", () => {
  const { session, controller, frames, error } = setup();
  session.begin({ layer: 2 });
  controller.previewText.mockReturnValueOnce({ ok: false, code: "invalid", message: "字号无效" });
  session.preview({ ...draft, size: 0 }); frames[0](0);
  controller.previewText.mockReturnValueOnce({ ok: false, code: "invalid", message: "字号无效" });
  expect(session.commit()).toBe(false);
  expect(controller.commitText).not.toHaveBeenCalled();
  expect(session.active).toBe(true); expect(error).toHaveBeenCalledWith("字号无效");
  session.preview(draft); expect(session.commit()).toBe(true);
});

it("确认失败保留会话，可取消；失败的开始不占用会话", () => {
  const { session, controller } = setup();
  controller.beginText.mockReturnValueOnce({ ok: false, code: "locked", message: "已锁定" } as never);
  expect(session.begin({ layer: 2 })).toBe(false);
  expect(session.active).toBe(false);
  expect(session.begin({ layer: 2 })).toBe(true);
  controller.commitText.mockReturnValueOnce({ ok: false, code: "failed", message: "无法确认" } as never);
  expect(session.commit()).toBe(false);
  expect(session.active).toBe(true);
  session.compositionStart(); session.cancel();
  expect(session.composing).toBe(false);
  expect(session.active).toBe(false);
  expect(controller.cancelText).toHaveBeenCalledOnce();
});
