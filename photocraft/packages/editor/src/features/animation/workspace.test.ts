/**
 * 动画域会话的门禁与结果形状（U77）。
 *
 * 面板测试用的是替身控制器，覆盖不到「域会话自己怎么拦」；这里直接调用域函数，固定三条
 * 容易被绕过的事务边界：
 * - 写入（建/删/改属性、帧编辑、帧导入）在草稿未结算时**不调用内核**；
 * - 导航在草稿未结算时**照常放行**（spec：草稿阻塞写入但不阻塞导航读取）；
 * - 交付读的是显示内容，草稿未结算时拒绝，避免把预览烧进交付结果。
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorFailure, EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import {
  createTimeline,
  deleteTimeline,
  deliveryPlan,
  flushVideoFrames,
  importFrames,
  navigateTimeline,
  renderAnimationGif,
  renderFrame,
  setTimelineProps,
  videoLayerCommand
} from "./workspace.js";

const VIEW = { hasDocument: true, document: { name: "art", width: 8, height: 8, activeLayerId: 1, revision: 2 } } as unknown as EditorViewModel;
const DRAFT: EditorFailure = { ok: false, code: "stroke-active", message: "请先结束当前笔迹" };

function context(options: { draft?: EditorFailure | null; result?: EditorResult<unknown> } = {}) {
  const calls: string[] = [];
  const answer = <T,>(name: string, value: T): EditorResult<T> => {
    calls.push(name);
    if (options.result && !options.result.ok) return options.result as EditorResult<T>;
    return { ok: true, value };
  };
  const handle = {
    execute: (id: string) => answer(`execute:${id}`, null),
    features: {
      animation: {
        timelineJson: () => answer("timelineJson", {}),
        createTimeline: () => answer("createTimeline", null),
        setTimelineProps: () => answer("setTimelineProps", null),
        navigateTimeline: () => answer("navigateTimeline", { result: null, historyAdded: 0 }),
        videoLayerCommand: () => answer("videoLayerCommand", null),
        importFrames: () => answer("importFrames", { layer: 1, frames: 2, width: 8, height: 8, fps: 24, duration: 2 }),
        deliveryPlan: () => answer("deliveryPlan", { frames: 2 }),
        renderFrame: () => answer("renderFrame", new Uint8Array(4)),
        renderAnimationGif: () => answer("renderAnimationGif", new Uint8Array([1])),
        flushVideoFrames: () => answer("flushVideoFrames", { written: false, reason: "unchanged" })
      }
    }
  };
  const afterWrite = vi.fn(() => ({ ok: true as const, value: VIEW }));
  const ctx = {
    handle,
    view: VIEW,
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => Boolean(options.draft),
    blockingDraft: () => options.draft ?? null,
    unavailable: () => ({ ok: false as const, code: "no-document", message: "未加载" }),
    fail: <T,>(failure: EditorFailure) => failure as EditorResult<T>,
    afterWrite
  } as unknown as WorkspaceFeatureContext;
  return { calls, ctx, afterWrite };
}

const importRequest = {
  name: "帧",
  width: 8,
  height: 8,
  fps: 24,
  frameCount: 2,
  pixels: new Uint8Array(8 * 8 * 4 * 2)
};

describe("动画域会话：草稿门禁", () => {
  it("写入在草稿未结算时不调用内核，并原样返回草稿原因", () => {
    for (const [label, run] of [
      ["createTimeline", (ctx: WorkspaceFeatureContext) => createTimeline.call(ctx, { duration: 2, fps: 24 })],
      ["setTimelineProps", (ctx: WorkspaceFeatureContext) => setTimelineProps.call(ctx, { fps: 12 })],
      ["deleteTimeline", (ctx: WorkspaceFeatureContext) => deleteTimeline.call(ctx)],
      ["videoLayerCommand", (ctx: WorkspaceFeatureContext) => videoLayerCommand.call(ctx, "layer.videoLayers.duplicateFrame")],
      ["importFrames", (ctx: WorkspaceFeatureContext) => importFrames.call(ctx, importRequest)],
      ["flushVideoFrames", (ctx: WorkspaceFeatureContext) => flushVideoFrames.call(ctx)]
    ] as const) {
      const { calls, ctx } = context({ draft: DRAFT });
      const result = run(ctx);
      expect(result, label).toEqual(DRAFT);
      expect(calls, label).toEqual([]);
    }
  });

  it("导航在草稿未结算时仍然放行，且不新增历史", () => {
    const { calls, ctx, afterWrite } = context({ draft: DRAFT });
    const result = navigateTimeline.call(ctx, "timeline.setFrame", { frame: 1 });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["navigateTimeline"]);
    expect(afterWrite).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.value.historyAdded).toBe(0);
      expect(result.value.view).toBe(VIEW);
    }
  });

  it("交付（计划/帧/GIF）在草稿未结算时被拒，不读内核", () => {
    for (const [label, run] of [
      ["deliveryPlan", (ctx: WorkspaceFeatureContext) => deliveryPlan.call(ctx)],
      ["renderFrame", (ctx: WorkspaceFeatureContext) => renderFrame.call(ctx, 0)],
      ["renderAnimationGif", (ctx: WorkspaceFeatureContext) => renderAnimationGif.call(ctx)]
    ] as const) {
      const { calls, ctx } = context({ draft: DRAFT });
      expect(run(ctx), label).toEqual(DRAFT);
      expect(calls, label).toEqual([]);
    }
  });
});

describe("动画域会话：结果形状", () => {
  it("写入成功后刷新一次视图，失败不刷新", () => {
    const ok = context();
    expect(createTimeline.call(ok.ctx, { duration: 2, fps: 24 })).toEqual({ ok: true, value: VIEW });
    expect(ok.afterWrite).toHaveBeenCalledTimes(1);

    const failed = context({ result: { ok: false, code: "command-failed", message: "帧率必须大于 0" } });
    const failure = createTimeline.call(failed.ctx, { duration: 2, fps: 0 });
    expect(failure.ok).toBe(false);
    expect(failed.afterWrite).not.toHaveBeenCalled();
  });

  it("删除时间轴走命令门，界面不需要知道命令 id", () => {
    const { calls, ctx } = context();
    expect(deleteTimeline.call(ctx)).toEqual({ ok: true, value: VIEW });
    expect(calls).toContain("execute:timeline.delete");
  });

  it("写回帧栈只在真的写了时刷新视图，并同时给出内核报告", () => {
    const unchanged = context();
    const kept = flushVideoFrames.call(unchanged.ctx);
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.value.flushed).toEqual({ written: false, reason: "unchanged" });
      expect(kept.value.view).toBeUndefined();
    }
    expect(unchanged.afterWrite).not.toHaveBeenCalled();

    const written = context();
    const animation = written.ctx.handle?.features.animation as unknown as { flushVideoFrames: () => EditorResult<unknown> };
    animation.flushVideoFrames = () => ({ ok: true, value: { written: true, reason: "written" } });
    const flushed = flushVideoFrames.call(written.ctx);
    expect(flushed.ok).toBe(true);
    if (flushed.ok) {
      expect(flushed.value.view).toBe(VIEW);
      expect(flushed.value.flushed).toEqual({ written: true, reason: "written" });
    }
    expect(written.afterWrite).toHaveBeenCalledTimes(1);
  });

  it("帧号不是非负整数时直接拒绝，不进入内核", () => {
    const { calls, ctx } = context();
    for (const frame of [-1, 1.5, Number.NaN]) {
      const result = renderFrame.call(ctx, frame);
      expect(result.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("未就绪（没有 handle）时统一返回不可用，不做任何调用", () => {
    const { ctx } = context();
    (ctx as unknown as { handle: null }).handle = null;
    for (const run of [
      () => createTimeline.call(ctx, { duration: 1, fps: 24 }),
      () => navigateTimeline.call(ctx, "timeline.nextFrame"),
      () => deliveryPlan.call(ctx),
      () => flushVideoFrames.call(ctx)
    ]) {
      const result = run();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no-document");
    }
  });
});
