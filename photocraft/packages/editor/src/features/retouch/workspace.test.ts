import { describe, expect, it } from "vitest";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { createSession } from "./workspace.js";

/**
 * 修饰域会话的草稿归属与选项补齐（change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 用替身内核锁定本域自己的契约：选项补齐后才进内核、晚到结果不写进别的文档、取消不补交、
 * 只读查询不制造写操作。真实像素与历史语义在 Rust 侧（`tests_workflows.rs`）。
 */

function view(name: string, revision = 1, size: { width: number; height: number } = { width: 8, height: 6 }): EditorViewModel {
  return {
    hasDocument: true,
    sessionActiveIndex: 0,
    document: {
    channelTarget: { kind: "composite" },

      name,
      width: size.width,
      height: size.height,
      mode: "rgb-u8",
      depthBits: 8,
      activeLayerId: 1,
      selectedLayerIds: [1],
      hasSelection: false,
      editTarget: "pixels",
      maskView: null,
      transformFrame: null,
      selectionOutline: [],
      selectionFrame: null,
      canUndo: false,
      canRedo: false,
      revision,
      history: ["打开"],
      redoHistory: [],
      layers: []
    }
  };
}

type Calls = { id: string; params: unknown }[];

/** `cloneSource.list` 的真实结构（与上游 `presets/clone_source.rs` 的 `to_json` 同形）。 */
const CLONE_LIST = {
  active: 1,
  sources: [
    { index: 0, source: null, anchor: null, offset: null, layer: null, width: 100, height: 100, linked: false, rotation: 0, flipH: false, flipV: false },
    { index: 1, source: [3, 4], anchor: [1, 1], offset: [2, 3], layer: 1, width: 200, height: 100, linked: true, rotation: 30, flipH: false, flipV: true }
  ],
  overlay: { show: true, opacity: 100, clipped: true, auto_hide: true, invert: false, blend: "normal" }
};

function harness(options: { document?: string; size?: { width: number; height: number }; fail?: string; clonePort?: "absent" } = {}) {
  const calls: Calls = [];
  const executed: Calls = [];
  const writes: number[] = [];
  const state = { view: view(options.document ?? "art", 1, options.size), active: false, drafts: 0 };
  const ok = <T,>(value: T): EditorResult<T> => ({ ok: true, value });
  const fail = (message: string): EditorResult<never> => ({ ok: false, code: "command-failed", message });
  const retouch = {
    beginRetouch: (id: string, params: unknown) => {
      calls.push({ id, params });
      if (options.fail) return fail(options.fail);
      state.active = true;
      return ok({ command: id, live: false });
    },
    appendRetouch: (points: unknown) => ok({ points }),
    commitRetouch: () => {
      state.active = false;
      writes.push(1);
      return ok({ points: 1 });
    },
    cancelRetouch: () => ok({ cancelled: true }),
    beginRetouchRegion: (id: string, params: unknown) => {
      calls.push({ id, params });
      state.active = true;
      return ok({ command: id, changed: true });
    },
    commitRetouchRegion: () => {
      state.active = false;
      writes.push(1);
      return ok({ changed: true });
    },
    cancelRetouchRegion: () => ok({ cancelled: true }),
    retouchHistorySources: () => ok({
      states: [
        { index: 0, label: "打开", current: false, available: false },
        { index: 1, label: "画笔", current: true, available: true }
      ]
    }),
    // 域只读端口：落笔期间也能读到取景（共享 `execute` 会被草稿门禁挡住）。
    ...(options.clonePort === "absent" ? {} : { retouchCloneSources: () => ok(CLONE_LIST) })
  };
  const handle = {
    features: { retouch },
    execute: (id: string, params: unknown) => {
      executed.push({ id, params });
      // 旧宿主没有域只读端口时仍走共享 `execute`：这里模拟落笔期间被草稿门禁拒绝。
      if (id === "cloneSource.list") return options.clonePort === "absent" ? fail("请先结束或取消当前修饰笔迹") : ok(CLONE_LIST);
      return ok({ index: 1 });
    }
  };
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    get handle() { return handle as never; },
    get view() { return state.view; },
    selectionModifyActive: false,
    get retouchActive() { return state.active; },
    set retouchActive(value: boolean) { state.active = value; },
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => state.drafts > 0,
    blockingDraft: () => null,
    unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未加载" }),
    fail: <T,>(failure: EditorResult<T> extends { ok: false } ? never : never) => failure as never,
    afterWrite: () => ok(state.view)
  };
  return { session: createSession(() => context), calls, executed, writes, state, context };
}

describe("修饰域会话", () => {
  it("补齐逐工具参数后才进内核，并把海绵的混合模式换成增/减饱和", () => {
    const { session, calls } = harness();
    session.setRetouchOptions({ spongeMode: "saturate", sampleLayer: "all" });
    expect(session.beginRetouch("paint.sponge", { points: [[1, 1]], mode: "normal" }).ok).toBe(true);
    expect(calls[0].params).toMatchObject({ points: [[1, 1]], mode: "saturate", vibrance: true });

    session.cancelRetouch();
    session.setRetouchOptions({ toneRange: "highlights", exposure: 70 });
    session.beginRetouch("paint.dodge", { points: [[2, 2]] });
    expect(calls[1].params).toMatchObject({ range: "highlights", exposure: 70, protectTones: true });

    session.cancelRetouch();
    session.setRetouchOptions({ strength: 33, fingerPainting: true });
    session.beginRetouch("paint.smudge", { points: [[3, 3]] });
    expect(calls[2].params).toMatchObject({ strength: 33, fingerPainting: true, sampleAllLayers: true });
  });

  it("拒绝越界参数与区域命令的笔迹入口，不发起内核调用", () => {
    const { session, calls } = harness();
    // 面板输入先钳制：0 曝光被纠正为 1，越界值不会进内核。
    expect(session.setRetouchOptions({ exposure: 0 }).exposure).toBe(1);
    expect(session.setRetouchOptions({ strength: 1000 }).strength).toBe(100);
    expect(session.setRetouchOptions({ historyState: -5 }).historyState).toBe(0);
    expect(session.beginRetouch("select.all", { points: [[1, 1]] }).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(session.beginRetouch("paint.patch", { offset: [2, 0] }).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(session.beginRetouchRegion("paint.blur", {}).ok).toBe(false);
    expect(calls).toHaveLength(0);
    // 域内校验仍然拦住直接构造的越界选项（不经面板）。
    const raw = harness();
    raw.session.setRetouchOptions({ toneRange: "elsewhere" as never });
    expect(raw.session.retouchOptions().toneRange).toBe("midtones");
  });

  it("草稿门禁阻止并发，提交只发布一次并清空归属", () => {
    const { session, state, writes } = harness();
    expect(session.beginRetouch("paint.blur", { points: [[1, 1]] }).ok).toBe(true);
    state.drafts = 1;
    expect(session.beginRetouch("paint.blur", { points: [[1, 1]] }).ok).toBe(false);
    state.drafts = 0;
    expect(session.retouchOwnership()?.attemptId).toContain("retouch-stroke");
    expect(session.commitRetouch().ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(session.retouchOwnership()).toBeNull();
    expect(session.hasRetouch()).toBe(false);
  });

  it("晚到追加/确认在文档切换后丢弃，不写进新文档", () => {
    const { session, state, writes } = harness();
    session.beginRetouch("paint.dodge", { points: [[1, 1]] });
    state.view = view("other");
    expect(session.retouchOwnership()).toBeNull();
    expect(session.appendRetouch([[2, 2]]).ok).toBe(false);
    expect(session.commitRetouch().ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("区域候选取消不补交，确认失败也清空门禁", () => {
    const { session, state, writes } = harness();
    session.beginRetouchRegion("paint.redEye", { x: 1, y: 1 });
    expect(session.retouchOwnership()?.attemptId).toContain("retouch-region");
    session.cancelRetouchRegion();
    expect(session.hasRetouch()).toBe(false);
    expect(writes).toHaveLength(0);
    expect(state.active).toBe(false);
  });

  it("只读查询不写入：历史源解码与仿制源列表", () => {
    const { session, executed, writes } = harness();
    const sources = session.retouchHistorySources();
    expect(sources.ok && sources.value.map((entry) => entry.index)).toEqual([0, 1]);
    const clones = session.cloneSources();
    expect(clones.ok && clones.value.slots[1]).toMatchObject({ source: [3, 4], width: 200, rotation: 30, flipV: true });
    expect(clones.ok && clones.value.overlay.blend).toBe("normal");
    // 优先走域端口（落笔期间也读得到），不再绕共享 `execute` 撞草稿门禁。
    expect(executed.map((call) => call.id)).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("旧宿主缺仿制源只读端口时回落 execute 并明确失败，不返回空槽位", () => {
    const { session, executed } = harness({ clonePort: "absent" });
    const clones = session.cloneSources();
    expect(clones.ok).toBe(false);
    expect(clones.ok === false && clones.message).toContain("请先结束或取消当前修饰笔迹");
    // 旧路径仍会尝试读一次（宿主自己决定是不是拒绝），但不伪造成功。
    expect(executed.map((call) => call.id)).toEqual(["cloneSource.list"]);
  });

  it("画布拖动直接开始区域候选，零偏移与红眼拖动被拒绝且不发起内核调用", () => {
    const { session, calls } = harness();
    const zero = session.beginRetouchRegionDrag("paint.patch", {
      from: { x: 4, y: 4 },
      to: { x: 4, y: 4 }
    });
    expect(zero.ok).toBe(false);
    expect(calls).toHaveLength(0);
    // 红眼不是拖动：不能借拖动入口开一次红眼候选。
    const drag = session.beginRetouchRegionDrag("paint.redEye", {
      from: { x: 4, y: 4 },
      to: { x: 12, y: 4 }
    });
    expect(drag.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const started = session.beginRetouchRegionDrag("paint.contentAwareMove", {
      from: { x: 4, y: 4 },
      to: { x: 14, y: 9 }
    });
    expect(started.ok).toBe(true);
    expect(calls[0].id).toBe("paint.contentAwareMove");
    expect(calls[0].params).toMatchObject({ offset: [10, 5], mode: "move" });
    session.cancelRetouchRegion();
  });

  it("红眼位置按像素累积，开始候选后保留到确认成功才清空", () => {
    const { session, calls } = harness();
    expect(session.beginRedEye().ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(session.markRedEye({ x: 12.4, y: 9.6 }).ok).toBe(true);
    expect(session.markRedEye({ x: 20, y: 9 }).ok).toBe(true);
    // 同一像素重复标记被拒绝，但已有标记保留。
    const duplicate = session.markRedEye({ x: 12.1, y: 9.9 });
    expect(duplicate.ok).toBe(false);
    expect(session.redEyePoints()).toEqual([[12, 10], [20, 9]]);
    const begun = session.beginRedEye({ redEyePupilSize: 70 });
    expect(begun.ok).toBe(true);
    expect(calls[0].id).toBe("paint.redEye");
    expect(calls[0].params).toMatchObject({ points: [[12, 10], [20, 9]], pupilSize: 70 });
    // spec 要求取消时「保留可恢复输入」：位置留到确认成功，取消一次不用用户重新点。
    expect(session.redEyePoints()).toEqual([[12, 10], [20, 9]]);
    session.cancelRetouchRegion();
    expect(session.redEyePoints()).toEqual([[12, 10], [20, 9]]);
    // 再算一次并确认成功后才清空，避免同一处被下一份候选重复带入。
    expect(session.beginRedEye({ redEyePupilSize: 70 }).ok).toBe(true);
    // 候选进行中画布不能再加点：候选的点集已经交给内核，追加会让两处不一致。
    const during = session.markRedEye({ x: 30, y: 30 });
    expect(during.ok).toBe(false);
    expect(during.ok ? "" : during.message).toContain("确认或取消");
    session.commitRetouchRegion();
    expect(session.redEyePoints()).toEqual([]);
    expect(session.clearRedEye()).toBe(0);
  });

  it("叠加取样框与落笔同一份映射；没有取样点或落笔时返回 null", () => {
    const { session } = harness();
    const toScreen = (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 });
    // harness 的活动槽位是 1（source [3,4]、宽 200%、旋转 30°、垂直翻转）。
    const frame = session.cloneOverlayFrame(20, false, toScreen);
    expect(frame.ok && frame.value).not.toBeNull();
    const corners = frame.ok ? frame.value!.corners : [];
    expect(corners).toHaveLength(4);
    // 落笔自动隐藏：同一槽位在落笔中不返回框。
    const hidden = session.cloneOverlayFrame(20, true, toScreen);
    expect(hidden.ok && hidden.value).toBeNull();
    // 换算失败（元素未布局）时不画到 (0,0)。
    const unlaid = session.cloneOverlayFrame(20, false, () => null);
    expect(unlaid.ok && unlaid.value).toBeNull();
  });

  it("仿制源命令按槽位钳制后发送", () => {
    const { session, executed } = harness();
    session.selectCloneSource(9);
    session.setCloneSource(2, { width: 4000, rotation: 400, flipH: true });
    session.resetCloneSourceTransform(1);
    // 未知混合模式显式拒绝：不发空补丁，也不假装成功。
    const rejected = session.setCloneOverlay({ opacity: 400, blend: "multiply" as never });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.message).toContain("multiply");
    // 合法叠加照常发送，并且只发钳制后的值。
    expect(session.setCloneOverlay({ opacity: 400, blend: "darken" }).ok).toBe(true);
    expect(executed.map((call) => call.id)).toEqual([
      "cloneSource.select",
      "cloneSource.set",
      "cloneSource.resetTransform",
      "cloneSource.overlay"
    ]);
    expect(executed[0].params).toEqual({ index: 4 });
    expect(executed[1].params).toMatchObject({ index: 2, width: 1000, rotation: 180, flipH: true });
    expect(executed[3].params).toEqual({ opacity: 100, blend: "darken" });
  });

  it("共享画笔的 0–1 小数被换算成内核要求的百分比（真实缺陷回归）", () => {
    // 上游 `retouch_cmds::stroke_brush` 把 hardness/opacity/flow 当百分比（`/100`，
    // opacity/flow 下限 1）。共享 `buildStroke` 发的是 0–1 小数，直接透传会让修饰笔迹的
    // 有效不透明度只剩 1%：真实 UI 里「落笔成功、也是一步历史，但画面几乎没有变化」。
    const { session, calls } = harness();
    session.beginRetouch("paint.blur", {
      points: [[1, 2]],
      size: 24,
      hardness: 0.8,
      opacity: 1,
      flow: 0.5,
      spacing: 0.25,
      strength: 50
    });
    const sent = calls[0].params as Record<string, number>;
    expect(sent.hardness).toBe(80);
    expect(sent.opacity).toBe(100);
    expect(sent.flow).toBe(50);
    // 尺寸与间距不参与换算：它们本来就不是百分比字段。
    expect(sent.size).toBe(24);
    expect(sent.spacing).toBe(0.25);
  });

  it("显式给出的百分比不被二次放大", () => {
    // 面板之外的调用方（脚本、内核测试）直接用 0–100：60 必须保持 60，不能变成 6000。
    const { session, calls } = harness();
    session.beginRetouch("paint.sponge", { points: [[1, 1]], hardness: 60, opacity: 100, flow: 90, size: 8 });
    const sent = calls[0].params as Record<string, number>;
    expect(sent.hardness).toBe(60);
    expect(sent.opacity).toBe(100);
    expect(sent.flow).toBe(90);
  });

  it("区域候选归属可从会话读回：画布拖动生成的候选也能被面板确认", () => {
    // 真实界面：画布拖动直接 `beginRetouchRegionDrag` 生成候选，而面板里本地的 `active`
    // 仍是 false，导致「确认」永远不可按。面板必须能读到同一份真值。
    const { session } = harness();
    expect(session.retouchRegionActive()).toBe(false);
    expect(session.beginRetouchRegionDrag("paint.patch", { from: { x: 2, y: 3 }, to: { x: 9, y: 7 } }).ok).toBe(true);
    expect(session.retouchRegionActive()).toBe(true);
    session.commitRetouchRegion();
    expect(session.retouchRegionActive()).toBe(false);
  });

  it("取消区域候选后归属立即失效，不留下半次修补", () => {
    const { session, writes } = harness();
    session.beginRetouchRegionDrag("paint.contentAwareMove", { from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    session.cancelRetouchRegion();
    expect(session.retouchRegionActive()).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("取样点落在当前文档外时开始前拒绝，不提交一笔零变化的历史", () => {
    // 设计 D2：取样源失效（换到更小/别的文档）时必须在落笔前提示重取样。上游对越界采样点
    // 是静默钳制——整笔零像素变化却仍新增一条历史，界面也没有任何提示。
    const { session, calls } = harness();
    const stale = session.beginRetouch("paint.cloneStamp", { points: [[1, 1]], source: [300, 300] });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? "" : stale.message).toContain("重新");
    expect(stale.ok ? "" : stale.message).toContain("8×6");
    expect(calls).toHaveLength(0);
    // 文档内的取样点照常放行（含右下边界）。
    expect(session.beginRetouch("paint.cloneStamp", { points: [[1, 1]], source: [8, 6] }).ok).toBe(true);
    // 没有显式取样点时看活动槽位：替身的槽位源 (3, 4) 落在 8×6 文档内，照常放行。
    const { session: slotOnly } = harness();
    expect(slotOnly.beginRetouch("paint.cloneStamp", { points: [[1, 1]] }).ok).toBe(true);
    // 不取样的工具不受这条校验影响。
    const { session: blur } = harness();
    expect(blur.beginRetouch("paint.blur", { points: [[1, 1]], source: [300, 300] }).ok).toBe(true);
  });

  it("切到更小的文档后，槽位里的旧取样点会阻止落笔而不是静默提交空历史", () => {
    // 这条才是换文档后最常见的情形：笔迹参数里根本没有 `source`（由内核读活动槽位），
    // 只看参数就会漏判；而槽位是会话级工具状态，跨文档保留旧点。
    const { session, calls } = harness({ size: { width: 2, height: 2 } });
    const stale = session.beginRetouch("paint.cloneStamp", { points: [[1, 1]] });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? "" : stale.message).toContain("仿制图章");
    expect(calls).toHaveLength(0);
  });
});
