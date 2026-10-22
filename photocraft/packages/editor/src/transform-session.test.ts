import { afterEach, expect, it, vi } from "vitest";
import { TransformSession } from "./transform-session.js";
import type { EditorWorkspaceController } from "./editor-workspace.js";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let callback: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", vi.fn((next: FrameRequestCallback) => { callback = next; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { callback = null; }));
  const controller = { beginTransform: vi.fn(() => ({ ok: true })), previewTransform: vi.fn((_matrix: readonly number[]) => ({ ok: true } as { ok: boolean; message?: string })),
    commitTransform: vi.fn(() => ({ ok: true })), cancelTransform: vi.fn() };
  const refresh = vi.fn(), error = vi.fn();
  const session = new TransformSession(controller as unknown as EditorWorkspaceController, refresh, error);
  return { session, controller, refresh, error, frame: () => { const fn = callback; callback = null; fn?.(0); } };
}
it("一帧只预览最后矩阵，确认补齐尾部，一次提交", () => {
  const { session, controller, frame } = setup();
  expect(session.begin()).toBe(true);
  session.preview([1,0,0,1,1,0]); session.preview([1,0,0,1,5,0]);
  expect(controller.previewTransform).not.toHaveBeenCalled(); frame();
  expect(controller.previewTransform).toHaveBeenCalledOnce();
  expect(controller.previewTransform).toHaveBeenCalledWith([1,0,0,1,5,0]);
  session.preview([2,0,0,2,5,0]);
  expect(session.commit()).toBe(true);
  expect(controller.previewTransform).toHaveBeenLastCalledWith([2,0,0,2,5,0]);
  expect(controller.commitTransform).toHaveBeenCalledOnce();
  expect(session.commit()).toBe(false);
});
it("取消清除待预览矩阵，迟到帧不提交，恢复正式预览", () => {
  const { session, controller, frame, refresh } = setup();
  session.begin(); session.preview([2,0,0,2,0,0]); session.cancel(); frame();
  expect(controller.previewTransform).not.toHaveBeenCalled();
  expect(controller.commitTransform).not.toHaveBeenCalled();
  expect(controller.cancelTransform).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});
it("预览失败不确认上一张成功草稿，保留会话供取消", () => {
  const { session, controller, error } = setup();
  session.begin();
  controller.previewTransform.mockReturnValue({ ok: false, message: "无法变换" });
  session.preview([0,0,0,0,0,0]);
  expect(session.commit()).toBe(false);
  expect(controller.commitTransform).not.toHaveBeenCalled();
  expect(session.active).toBe(true); expect(error).toHaveBeenCalledWith("无法变换");
  session.cancel();
});
it("取消后的迟到帧不能消费下一次变换，预览矩阵使用输入快照",()=>{
  const callbacks:FrameRequestCallback[]=[];
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{callbacks.push(callback);return callbacks.length;});
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const port={beginTransform:()=>({ok:true}),previewTransform:vi.fn(()=>({ok:true})),commitTransform:()=>({ok:true}),cancelTransform:vi.fn()};
  const session=new TransformSession(port as unknown as EditorWorkspaceController,vi.fn(),vi.fn());
  session.begin();session.preview([1,0,0,1,1,0]);session.cancel();
  session.begin();const matrix=[1,0,0,1,10,0];session.preview(matrix);matrix[4]=100;
  callbacks[0]!(0);expect(port.previewTransform).not.toHaveBeenCalled();
  callbacks[1]!(0);expect(port.previewTransform).toHaveBeenCalledWith([1,0,0,1,10,0]);
  expect(session.commit()).toBe(true);callbacks[1]!(0);expect(port.previewTransform).toHaveBeenCalledTimes(1);
});
