/**
 * 画布参考线/原点拖动会话回归（U70，change:
 * `2026-10-22-add-photocraft-view-workspace-workflows`）。
 *
 * 这层决定「拖动期间不动文档、松手才一步历史、取消什么都不写」，因此逐条锁定：
 * 命中不写、草稿只在内存、值未变不提交、切文档后目标被拒、非活动视图被拒。
 */
import { describe, expect, it, vi } from "vitest";
import { ViewGestureSession, type ViewGesturePorts } from "./guide-gesture.js";

type PointerResult = Awaited<ReturnType<ViewGesturePorts["pointer"]>>;

function session(options: {
  hit?: { vertical: boolean; index: number; position: number; distance?: number } | null;
  locked?: boolean;
  dragPosition?: number | null;
  origin?: [number, number] | null;
  current?: [number, number];
  commitOk?: boolean;
  commitMessage?: string;
  documentId?: number;
  viewId?: string;
} = {}) {
  const commit = vi.fn((id: string, params: Record<string, unknown>) =>
    options.commitOk === false
      ? ({ ok: false, code: "view.stale", message: options.commitMessage ?? "目标文档已切换" } as const)
      : ({ ok: true, value: { id, params } } as const),
  );
  const pointer = vi.fn((action: string): PointerResult => {
    if (action === "hit-guide") {
      const hit = options.hit ? { distance: 1, ...options.hit } : null;
      return { ok: true, value: {
 kind: "hit", locked: options.locked ?? false, hit } };
    }
    if (action === "drag-guide") {
      return { ok: true, value: {
 kind: "drag", vertical: true, position: options.dragPosition ?? null, locked: options.locked ?? false } };
    }
    return { ok: true, value: { kind: "origin", origin: options.origin ?? null, current: options.current ?? [0, 0] } };
  });
  const gesture = new ViewGestureSession({

    pointer: pointer as unknown as ViewGesturePorts["pointer"],
    commit: commit as unknown as ViewGesturePorts["commit"],
    documentId: options.documentId,
    viewId: options.viewId,
    locked: options.locked,
  });
  return { gesture, commit, pointer };
}

describe("参考线拖动会话", () => {
  it("命中只读：开始拖动不写文档，草稿停在按下位置", () => {
    const { gesture, commit } = session({ hit: { vertical: true, index: 2, position: 30 } });
    const started = gesture.beginGuide([10, 10]);
    expect(started.locked).toBe(false);
    expect(started.drag).toMatchObject({ kind: "guide", vertical: true, index: 2, from: 30, position: 30 });
    expect(commit).not.toHaveBeenCalled();
    expect(gesture.dragging).toBe(true);
  });

  it("移动只更新草稿，松手才提交一条 view.moveGuide", () => {
    const { gesture, commit } = session({ hit: { vertical: true, index: 1, position: 20 }, dragPosition: 44.5 });
    gesture.beginGuide([10, 10]);
    const draft = gesture.update([60, 10]);
    expect(draft).toMatchObject({ kind: "guide", position: 44.5 });
    expect(commit).not.toHaveBeenCalled();
    const result = gesture.commit();
    expect(result).toEqual({ ok: true, value: { changed: true } });
    expect(commit).toHaveBeenCalledWith("view.moveGuide", {
      orientation: "vertical", index: 1, position: 44.5,
    });
    expect(gesture.dragging).toBe(false);
  });

  it("没有命中就不接管按下：画布继续按当前工具处理", () => {
    const { gesture, commit } = session({ hit: null });
    expect(gesture.beginGuide([10, 10])).toEqual({
 locked: false, drag: null });
    expect(gesture.dragging).toBe(false);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("锁定的参考线不进入拖动（界面显示禁止而不是拖了没反应）", () => {
    const { gesture, commit } = session({
 hit: { vertical: false, index: 0, position: 5 }, locked: true });
    expect(gesture.beginGuide([3, 3])).toEqual({
 locked: true, drag: null });
    expect(gesture.dragging).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("位置没变不提交，避免拖动 1px 内松手多一步空历史", () => {
    const { gesture, commit } = session({ hit: { vertical: true, index: 0, position: 12 } });
    gesture.beginGuide([10, 10]);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("取消只丢草稿：不提交、不写文档、不造历史", () => {
    const { gesture, commit } = session({ hit: { vertical: true, index: 0, position: 12 }, dragPosition: 60 });
    gesture.beginGuide([10, 10]);
    gesture.update([80, 10]);
    gesture.cancel();
    expect(gesture.dragging).toBe(false);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("非法拖动位置保持上一个草稿，不把参考线丢到 NaN 上", () => {
    const { gesture } = session({ hit: { vertical: true, index: 0, position: 12 }, dragPosition: 40 });
    gesture.beginGuide([10, 10]);
    gesture.update([50, 10]);
    const held = gesture.update([50, 10]);
    expect(held).toMatchObject({ position: 40 });
  });

  it("拖动目标文档随会话捕获并在提交时回传", () => {
    const { gesture, commit } = session({ hit: { vertical: true, index: 0, position: 1 }, dragPosition: 9, documentId: 7 });
    gesture.beginGuide([1, 1]);
    gesture.update([2, 2]);
    gesture.commit();
    expect(commit).toHaveBeenCalledWith("view.moveGuide", {
      orientation: "vertical", index: 0, position: 9, targetDocument: 7,
    });
  });

  it("提交被内核拒绝时原样上报，草稿不残留", () => {
    const { gesture } = session({
      hit: { vertical: true, index: 0, position: 1 }, dragPosition: 9, documentId: 7,
      commitOk: false, commitMessage: "目标文档已切换：请刷新视图后再重试",
    });
    gesture.beginGuide([1, 1]);
    gesture.update([2, 2]);
    const result = gesture.commit();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("目标文档已切换");
    expect(gesture.dragging).toBe(false);
  });
});

describe("标尺原点拖动会话", () => {
  it("拖动只改草稿，松手提交 view.setRulerOrigin", () => {
    const { gesture, commit } = session({ current: [4, 5], origin: [11, 12] });
    const started = gesture.beginOrigin([0, 0]);
    expect(started).toMatchObject({ kind: "origin", from: [4, 5], origin: [4, 5] });
    gesture.update([30, 30]);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: true } });
    expect(commit).toHaveBeenCalledWith("view.setRulerOrigin", { x: 11, y: 12 });
  });

  it("原点没动就不提交", () => {
    const { gesture, commit } = session({ current: [4, 5], origin: [4, 5] });
    gesture.beginOrigin([0, 0]);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("反算不出新位置时保留按下时的原点，不把原点丢到非法值", () => {
    const { gesture } = session({ current: [4, 5], origin: null });
    const started = gesture.beginOrigin([0, 0]);
    expect(started).toMatchObject({ kind: "origin", origin: [4, 5] });
    gesture.update([80, 80]);
    expect(gesture.current()).toMatchObject({ origin: [4, 5] });
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
  });
});

describe("来源视图核对", () => {
  it("会话把来源视图 id 透传给内核（多视图只有活动视图接收输入）", () => {
    const { gesture, pointer } = session({ hit: { vertical: true, index: 0, position: 1 }, viewId: "view-2" });
    gesture.beginGuide([10, 10]);
    expect(pointer).toHaveBeenCalledWith("hit-guide", [10, 10], { tolerance: 6, viewId: "view-2" });
  });
});

describe("从标尺条拖出新参考线", () => {
  it("按下即建立草稿，移动只更新位置，松手发一条 view.newGuide", () => {
    const { gesture, commit } = session({ dragPosition: 48 });
    const drag = gesture.startRulerGuide(true, 7);
    expect(drag).toMatchObject({ kind: "guide", vertical: true, mode: "create", index: -1 });
    expect(gesture.trackedPointer).toBe(7);
    expect(commit).not.toHaveBeenCalled();

    gesture.update([10, 60]);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: true } });
    // 新建不带索引：没有「原位置」可以直接调用，也不需要用户先选第几条。
    expect(commit).toHaveBeenCalledWith("view.newGuide", { orientation: "vertical", position: 48 });
  });

  it("没移动就松手不建线，避免单击标尺留下一堆 0 位置的参考线", () => {
    const { gesture, commit } = session({});
    gesture.startRulerGuide(false, 3);
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("参考线锁定时不从标尺拖出新线", () => {
    const { gesture, commit } = session({
 locked: true });
    expect(gesture.startRulerGuide(true, 1)).toBeNull();
    expect(gesture.trackedPointer).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("拖出后取消不建线，指针跟踪一并松开", () => {
    const { gesture, commit } = session({ dragPosition: 20 });
    gesture.startRulerGuide(true, 9);
    gesture.update([30, 30]);
    gesture.cancel();
    gesture.releasePointer();
    expect(gesture.trackedPointer).toBeNull();
    expect(gesture.commit()).toEqual({ ok: true, value: { changed: false } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("新建的线同样带上目标文档身份", () => {
    const { gesture, commit } = session({ dragPosition: 12, documentId: 5 });
    gesture.startRulerGuide(false, 2);
    gesture.update([0, 12]);
    gesture.commit();
    expect(commit).toHaveBeenCalledWith("view.newGuide", {
      orientation: "horizontal", position: 12, targetDocument: 5,
    });
  });
});
