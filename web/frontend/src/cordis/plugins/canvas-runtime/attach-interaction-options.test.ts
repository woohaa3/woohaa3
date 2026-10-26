/**
 * Canvas Runtime attach 装配测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 4.1/5.1）。
 *
 * 回归守卫：片场对象局部键盘 action（`filmSetObjectAction`）必须随 controller 构造注入。
 * 真实浏览器验收曾发现 `buildAttachInteractionOptions` 只转发了 gesture 而漏掉 action，
 * 导致 Delete/Backspace/分层 Escape 在窗口键盘路由上失效（按钮仍可用）。
 */
import { describe, expect, it, vi } from "vitest";
import { buildAttachInteractionOptions, type AttachAssemblyDeps } from "./attach-interaction-options.js";
import type { InteractionControllerOptions } from "../canvas-shell/interaction-types.js";

function deps(overrides: Partial<AttachAssemblyDeps> = {}): AttachAssemblyDeps {
  const base: AttachAssemblyDeps = {
    canvas: {} as HTMLCanvasElement,
    options: { getSession: () => null } as unknown as AttachAssemblyDeps["options"],
    textureSync: { dispose: () => undefined } as never,
    videoSessions: {} as never,
    compositeAssetMediaSessions: {} as never,
    getRuntime: () => null,
    getModelResources: () => new Map(),
    theme: () => ({}) as never,
    getGhostNodes: () => [],
    modelFocus: () => null,
    modelFocusMode: () => "edit",
    focusTargets: () => [],
    imageFocusTargetId: () => null,
    imageFocus: () => null,
    videoFocusTargetId: () => null,
    videoFocus: () => null,
    modelSceneOverride: () => null,
    contentRectRight: () => 0,
    focusRect: () => null,
    modelEditor: () => null,
    animationPlayback: () => null,
    focusTransition: () => null,
    runState: () => null,
    gestures: { shot: null, focus: null, shotWheel: null, object: null, objectAction: null },
    onModelFocusChange: () => undefined,
    onViewportChange: () => undefined
  };
  return { ...base, ...overrides };
}

const ACTION: NonNullable<InteractionControllerOptions["filmSetObjectAction"]> = {
  active: () => true,
  hasSelection: () => true,
  pending: () => false,
  deleteSelected: () => true,
  clearSelection: () => true,
  cancelGesture: () => true
};

describe("buildAttachInteractionOptions 片场对象键盘 action（任务 4.1/5.1）", () => {
  it("图片取景目标在 controller 装配后仍读取当前 owner", () => {
    const target = { read: () => ({ viewport: { x: 0, y: 0, zoom: 1 }, rect: { x: 0, y: 0, width: 800, height: 600 } }), write: vi.fn() };
    let active: typeof target | null = null;
    const options = buildAttachInteractionOptions(deps({ imageViewportTarget: () => active }));
    expect(options.getImageViewportTarget?.()).toBeNull();
    active = target;
    options.getImageViewportTarget?.()?.write({ x: 10, y: 20, zoom: 2 });
    expect(target.write).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 2 });
    active = null;
    expect(options.getImageViewportTarget?.()).toBeNull();
  });

  it("转发已注册的 filmSetObjectAction 到交互 options", () => {
    const options = buildAttachInteractionOptions(
      deps({ gestures: { shot: null, focus: null, shotWheel: null, object: null, objectAction: ACTION } })
    );
    expect(options.filmSetObjectAction).toBe(ACTION);
  });

  it("未注册时省略该选项（回退 options 缺省）", () => {
    const options = buildAttachInteractionOptions(deps());
    expect(options.filmSetObjectAction).toBeUndefined();
  });

  it("手势与键盘 action 可同时注入且互不覆盖", () => {
    const gesture = {
      active: () => true,
      select: vi.fn(() => true),
      begin: vi.fn(() => true),
      move: vi.fn(),
      end: vi.fn(),
      cancel: vi.fn()
    };
    const options = buildAttachInteractionOptions(
      deps({ gestures: { shot: null, focus: null, shotWheel: null, object: gesture, objectAction: ACTION } })
    );
    expect(options.filmSetObjectGesture).toBe(gesture);
    expect(options.filmSetObjectAction).toBe(ACTION);
  });
});


it("forwards the per-scene model-loading reader getter without resolving it during assembly", () => {
  const getModelLoading = vi.fn(() => (_id: string) => false);
  const assembly = deps();
  assembly.options = { ...assembly.options, getModelLoading };
  const options = buildAttachInteractionOptions(assembly);
  expect(options.getModelLoading).toBe(getModelLoading);
  expect(getModelLoading).not.toHaveBeenCalled();
  expect(buildAttachInteractionOptions(deps()).getModelLoading).toBeUndefined();
});
