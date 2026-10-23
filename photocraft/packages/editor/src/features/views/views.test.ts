import { describe, expect, it, vi } from "vitest";
import {
  decodeLengthFormat,
  decodeMeasurementLog,
  decodeSamplerReadout,
  decodeViewAids,
  decodeViewSnapshot,
} from "./decode.js";
import { createHandle } from "./wasm-handle.js";
import { createSession } from "./workspace.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { FeatureHandleContext } from "../contracts.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";

/** 内核 `viewAidsJson()` 的真实形状（`ViewAids::to_json`）。 */
function aids(overrides: Record<string, unknown> = {}) {
  return {
    rulers: false,
    grid: false,
    gridStep: [18, 18],
    gridSubdivisions: 1,
    guides: true,
    lockGuides: false,
    smartGuides: true,
    snap: { document: true, guides: true, grid: false, layers: true, selection: false },
    suspend: false,
    units: "px",
    rotation: 0,
    navigator: false,
    activeView: "view-1",
    views: [{ id: "view-1", label: "视图 1", zoom: 1, offset: [0, 0], rotation: 0, active: true }],
    maxViews: 4,
    ...overrides,
  };
}

/** 内核 `viewSnapshotJson()` 的真实形状（`Editor::view_snapshot`）。 */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    scope: { view: "session", guides: "document", rulerOrigin: "document", samplers: "session+project", count: "document", notes: "document" },
    guides: {
 horizontal: [12.5], vertical: [30], colors: [], visible: true, locked: false },
    rulerOrigin: [0, 0],
    units: "px",
    unitOptions: ["px", "in", "cm", "mm", "pt", "pc", "%"],
    snapTargets: ["document", "guides", "grid", "layers", "selection"],
    maxViews: 4,
    documentSize: [120, 90],
    rotation: 0,
    transform: { zoom: 1, offset: [0, 0], rotation: 0, valid: true },
    projected: { origin: [0, 0], center: [60, 45] },
    samplers: [{ index: 0, position: [10, 20] }],
    measurement: {
      scale: { pixelLength: 1, logicalLength: 1, units: "pixels", describe: "1 pixels = 1.0000 pixels" },
      ruler: null,
      count: { total: 1, activeGroup: 0, groups: [{ name: "组", color: [1, 0, 0], markerSize: 1, labelSize: 8, visible: true, count: 1, points: [[1, 2]] }] },
      logRows: 0,
    },
    notes: [{ index: 0, author: "美术", text: "补光", color: [1, 1, 0.51], position: [4, 5], open: true }],
    ...overrides,
  };
}

describe("视图状态解码只接受内核真实形状", () => {
  it("接受完整视图辅助与多视图，保留取景归属", () => {
    const value = decodeViewAids(aids({
      rotation: 30,
      navigator: true,
      views: [
        { id: "view-1", label: "视图 1", zoom: 3, offset: [40, 0], rotation: 0, active: false },
        { id: "view-2", label: "视图 2", zoom: 1, offset: [0, 0], rotation: 30, active: true },
      ],
      activeView: "view-2",
    }));
    expect(value).not.toBeNull();
    expect(value!.rotation).toBe(30);
    expect(value!.views.map((view) => [view.id, view.zoom, view.active])).toEqual([["view-1", 3, false], ["view-2", 1, true]]);
    expect(value!.snap).toEqual({ document: true, guides: true, grid: false, layers: true, selection: false });
  });

  it("拒绝缺失字段、重复活动视图、越界缩放与非法视图上限", () => {
    expect(decodeViewAids({})).toBeNull();
    expect(decodeViewAids(aids({ maxViews: 0 }))).toBeNull();
    expect(decodeViewAids(aids({ rotation: 361 }))).toBeNull();
    expect(decodeViewAids(aids({ snap: { document: true, guides: true, grid: false, layers: true } }))).toBeNull();
    expect(decodeViewAids(aids({
      views: [
        { id: "view-1", label: "视图 1", zoom: 1, offset: [0, 0], rotation: 0, active: true },
        { id: "view-2", label: "视图 2", zoom: 1, offset: [0, 0], rotation: 0, active: true },
      ],
    }))).toBeNull();
    expect(decodeViewAids(aids({ views: [{ id: "view-1", label: "视图 1", zoom: 0, offset: [0, 0], rotation: 0, active: true }] }))).toBeNull();
    // activeView 必须指向真实存在的视图，否则界面切不到任何取景。
    expect(decodeViewAids(aids({ activeView: "view-9" }))).toBeNull();
  });

  it("快照保留持久/会话归属，并核对计数合计与活动分组", () => {
    const value = decodeViewSnapshot(snapshot());
    expect(value).not.toBeNull();
    expect(value!.scope.guides).toBe("document");
    expect(value!.scope.samplers).toBe("session+project");
    expect(value!.guides.vertical).toEqual([30]);
    expect(value!.measurement.count.total).toBe(1);
    expect(value!.notes[0]!.text).toBe("补光");
    expect(value!.unitOptions).toContain("mm");
    expect(value!.snapTargets).toEqual(["document", "guides", "grid", "layers", "selection"]);
  });

  it("文档身份可选但有值时必须合法：旧运行时退回不参与守卫，坏 id 整体拒绝", () => {
    // 旧运行时没有 `document` 字段：解码通过，界面只是无法证明写的是同一份文档。
    expect(decodeViewSnapshot(snapshot())!.document).toBeUndefined();
    const withId = snapshot();
    (withId as Record<string, unknown>).document = { id: 7 };
    expect(decodeViewSnapshot(withId)!.document).toEqual({ id: 7 });
    // 有字段就必须是整数 id：字符串/负数/非整数一律拒绝，不静默当成「没有」。
    for (const bad of [{ id: "7" }, { id: -1 }, { id: 1.5 }, { id: null }, "doc-7"]) {
      const broken = snapshot();
      (broken as Record<string, unknown>).document = bad;
      expect(decodeViewSnapshot(broken)).toBeNull();
    }
  });

  it("拒绝自相矛盾的快照（合计、活动分组、计数点、取样点上限）", () => {
    expect(decodeViewSnapshot({})).toBeNull();
    const badTotal = snapshot();
    (badTotal.measurement.count as Record<string, unknown>).total = 2;
    expect(decodeViewSnapshot(badTotal)).toBeNull();
    const badActive = snapshot();
    (badActive.measurement.count as Record<string, unknown>).activeGroup = 3;
    expect(decodeViewSnapshot(badActive)).toBeNull();
    // 累计预算：单组 10 万、组上限 256 时，跨组合计仍不得超过 10 万——先判额度再逐点校验。
    const overBudget = snapshot();
    const group = (overBudget.measurement.count.groups as Record<string, unknown>[])[0]!;
    group.points = Array.from({ length: 60_000 }, () => [1, 2]);
    group.count = 60_000;
    (overBudget.measurement.count as Record<string, unknown>).total = 60_000;
    (overBudget.measurement.count as Record<string, unknown>).groups = [group, { ...group }];
    expect(decodeViewSnapshot(overBudget)).toBeNull();
    const badPoints = snapshot();
    ((badPoints.measurement.count as Record<string, unknown>).groups as { points: unknown }[])[0]!.points = "nope";
    expect(decodeViewSnapshot(badPoints)).toBeNull();
    const tooManySamplers = snapshot({ samplers: Array.from({ length: 11 }, (_, index) => ({ index: index % 10, position: [0, 0] })) });
    expect(decodeViewSnapshot(tooManySamplers)).toBeNull();
    const badTransform = snapshot();
    (badTransform.transform as Record<string, unknown>).zoom = 0;
    expect(decodeViewSnapshot(badTransform)).toBeNull();
  });

  it("标尺线缺失时保持 null，存在时逐字段校验", () => {
    const value = decodeViewSnapshot(snapshot());
    expect(value!.measurement.ruler).toBeNull();
    const withRuler = snapshot();
    (withRuler.measurement as Record<string, unknown>).ruler = {
      start: [0, 0], end: [10, 10], protractor: null,
      info: { x: 0, y: 0, w: 10, h: 10, angle: 45, l1: 14.1421, l2: null, length: 14.1421, units: "px", protractor: false },
    };
    expect(decodeViewSnapshot(withRuler)!.measurement.ruler!.info.angle).toBe(45);
    const brokenRuler = snapshot();
    (brokenRuler.measurement as Record<string, unknown>).ruler = { start: [0, 0], end: [10, 10], protractor: null, info: { x: 0 } };
    expect(decodeViewSnapshot(brokenRuler!)!).toBeNull();
  });

  it("取样读数与长度格式化拒绝越界通道", () => {
    expect(decodeSamplerReadout({ index: 0, number: 1, position: [1, 2], rgb: [1, 2, 3], cmyk: [0, 0, 0, 100] })).not.toBeNull();
    expect(decodeSamplerReadout({ index: 0, number: 1, position: [1, 2], rgb: [300, 2, 3], cmyk: [0, 0, 0, 100] })).toBeNull();
    expect(decodeSamplerReadout({ index: 10, number: 11, position: [1, 2], rgb: [1, 2, 3], cmyk: [0, 0, 0, 100] })).toBeNull();
    expect(decodeLengthFormat({ text: "25.4 mm", unit: "mm" })).toEqual({ text: "25.4 mm", unit: "mm" });
    expect(decodeLengthFormat({ text: "", unit: "mm" })).toBeNull();
  });

  it("测量日志只保留可显示的行与列", () => {
    expect(decodeMeasurementLog({ rows: [{ id: 1, values: { L: 12, units: "mm" } }], columns: ["L", "units"] }))
      .toEqual({ rows: [{ id: 1, values: { L: 12, units: "mm" } }], columns: ["L", "units"] });
    expect(decodeMeasurementLog({ rows: [{ id: 1, values: { L: null } }], columns: [] })).toBeNull();
    expect(decodeMeasurementLog({ rows: [], columns: [1] })).toBeNull();
  });
});

// ---------------------------------------------------------------- 会话门禁

function context(handle: Record<string, unknown> | null, draft: { ok: false; code: string; message: string } | null = null) {
  const afterWrite = vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: null } }));
  const fail = vi.fn((failure: unknown) => failure);
  return {
    ctx: {
      handle,
      view: { hasDocument: !!handle, document: null, sessionActiveIndex: null },
      selectionModifyActive: false,
      retouchActive: false,
      filterActive: false,
      composeActive: false,
      hasActiveDraft: () => draft !== null,
      blockingDraft: () => draft,
      frozen: () => null,
      unavailable: () => ({ ok: false, code: "no-document", message: "编辑器尚未加载" }),
      fail,
      afterWrite,
    } as unknown as WorkspaceFeatureContext,
    afterWrite,
    fail,
  };
}

function viewsHandle(overrides: Record<string, unknown> = {}) {
  return {
    viewAids: vi.fn(() => ({ ok: true, value: aids() })),
    setViewAids: vi.fn(() => ({ ok: true, value: aids({ rotation: 45 }) })),
    snapPoint: vi.fn(() => ({ ok: true, value: { point: [50, 20], lines: [] } })),
    guideCommand: vi.fn(() => ({ ok: true, value: {} })),
    guideLayoutCommand: vi.fn(() => ({ ok: true, value: {} })),
    viewCommand: vi.fn(() => ({ ok: true, value: {} })),
    viewSnapshot: vi.fn(() => ({ ok: true, value: snapshot() })),
    samplerReadout: vi.fn(() => ({ ok: true, value: null })),
    formatLength: vi.fn(() => ({ ok: true, value: { text: "25.4 mm", unit: "mm" } })),
    measurementLog: vi.fn(() => ({ ok: true, value: { rows: [], columns: [] } })),
    viewPointer: vi.fn(() => ({ ok: true, value: {
 kind: "hit", locked: false, hit: null } })),
    ...overrides,
  };
}

describe("本域会话遵守草稿门禁与数据归属", () => {
  it("视图辅助与吸附是会话偏好：不经过草稿门禁", () => {
    const views = viewsHandle();
    const { ctx, afterWrite } = context({ features: { views } }, { ok: false, code: "compose-active", message: "请先确认或取消构图修改" });
    const session = createSession(() => ctx);
    expect(session.setViewAids({ rulers: true }).ok).toBe(true);
    expect(session.snapPoint([1, 2], 2).ok).toBe(true);
    expect(views.setViewAids).toHaveBeenCalledWith({ rulers: true });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("文档类命令先拒绝未结算草稿，再写入并刷新视图模型", () => {
    const views = viewsHandle();
    const blocked = createSession(() => context({ features: { views } }, { ok: false, code: "compose-active", message: "请先确认或取消构图修改" }).ctx);
    expect(blocked.guideCommand("view.newGuide", { orientation: "vertical", position: 10 }).ok).toBe(false);
    expect(blocked.viewCommand("notes.add", { x: 1, y: 1, text: "x" }).ok).toBe(false);
    expect(views.guideCommand).not.toHaveBeenCalled();

    const { ctx, afterWrite } = context({ features: { views } });
    const session = createSession(() => ctx);
    expect(session.guideCommand("view.newGuide", { orientation: "vertical", position: 10 }).ok).toBe(true);
    expect(session.guideLayoutCommand("view.newGuideLayout", { columns: 2 }).ok).toBe(true);
    expect(session.viewCommand("count.add", { x: 1, y: 2 }).ok).toBe(true);
    expect(afterWrite).toHaveBeenCalledTimes(3);
  });

  it("写入失败原样上报，且不刷新视图模型", () => {
    const views = viewsHandle({
      viewCommand: vi.fn(() => ({ ok: false, code: "capability-disabled", message: "count.unknown 不是已登记的能力" })),
    });
    const { ctx, afterWrite, fail } = context({ features: { views } });
    const result = createSession(() => ctx).viewCommand("count.unknown", {});
    expect(result.ok).toBe(false);
    expect(fail).toHaveBeenCalledOnce();
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("只读命令不经过草稿门禁，也没有文档时明确拒绝", () => {
    const views = viewsHandle();
    const session = createSession(() => context({ features: { views } }, { ok: false, code: "compose-active", message: "draft" }).ctx);
    expect(session.viewRead("measurementLog.list").ok).toBe(true);
    expect(views.viewCommand).toHaveBeenCalledWith("measurementLog.list", {});
    expect(createSession(() => context(null).ctx).viewRead("notes.list").ok).toBe(false);
  });

  it("旋转与多视图只改会话取景，取样点走只读列表", () => {
    const views = viewsHandle();
    const { ctx, afterWrite } = context({ features: { views } });
    const session = createSession(() => ctx);
    expect(session.rotateView(30).ok).toBe(true);
    expect(views.setViewAids).toHaveBeenLastCalledWith({ rotation: 30 });
    expect(session.rotateView("reset").ok).toBe(true);
    expect(views.setViewAids).toHaveBeenLastCalledWith({ rotation: "reset" });
    expect(session.viewAction("new").ok).toBe(true);
    expect(views.setViewAids).toHaveBeenLastCalledWith({ viewAction: "new" });
    expect(session.viewAction("activate", "view-2").ok).toBe(true);
    expect(views.setViewAids).toHaveBeenLastCalledWith({ viewAction: "activate", viewId: "view-2" });
    expect(session.samplerList().ok).toBe(true);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("指针几何是只读查询：不经过草稿门禁，也不刷新视图模型", () => {
    const views = viewsHandle();
    const blockedDraft = { ok: false as const, code: "compose-active", message: "draft" };
    const { ctx, afterWrite } = context({ features: { views } }, blockedDraft);
    const session = createSession(() => ctx);
    // 正在落笔/有草稿时仍可查询命中——它不写文档，也不该被草稿门禁挡住。
    expect(session.viewPointer("hit-guide", [10, 20]).ok).toBe(true);
    expect(views.viewPointer).toHaveBeenCalledWith("hit-guide", [10, 20], {});
    expect(session.viewPointer("drag-guide", [10, 20], { vertical: true }).ok).toBe(true);
    expect(views.viewPointer).toHaveBeenLastCalledWith("drag-guide", [10, 20], { vertical: true });
    expect(session.viewPointer("drag-origin", [10, 20]).ok).toBe(true);
    expect(afterWrite).not.toHaveBeenCalled();
    // 没有文档时与其它入口一样明确拒绝。
    expect(createSession(() => context(null).ctx).viewPointer("hit-guide", [0, 0]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 旧运行时与精简宿主

/** 只有 U70 四条端口的旧内核实例。 */
function legacyInstance(extra: Record<string, unknown> = {}) {
  return {
    viewAidsJson: () => JSON.stringify(aids()),
    setViewAids: (params: string) => JSON.stringify({ ...aids(), ...JSON.parse(params) }),
    snapPoint: () => JSON.stringify({ point: [0, 0], lines: [] }),
    guideCommand: () => JSON.stringify({}),
    ...extra,
  };
}

function legacyHandle(instance: Record<string, unknown>) {
  return createHandle(() => ({
    instance: instance as unknown as FeatureHandleContext["instance"],
    call: <T,>(run: (i: FeatureHandleContext["instance"]) => T): EditorResult<T> => {
      try {
        return { ok: true as const, value: run(instance as unknown as FeatureHandleContext["instance"]) };
      } catch (error) {
        return { ok: false as const, code: "command-failed", message: String(error) };
      }
    },
  }));
}

describe("缺少新端口时按能力关闭拒绝，而不是抛错", () => {
  it("U70 的四条端口在旧内核上仍然可用", () => {
    const handle = legacyHandle(legacyInstance());
    expect(handle.viewAids().ok).toBe(true);
    expect(handle.setViewAids({ rulers: true }).ok).toBe(true);
    expect(handle.snapPoint({ point: [1, 2] }).ok).toBe(true);
    expect(handle.guideCommand("view.newGuide", {}).ok).toBe(true);
  });

  it("端口缺失时返回 capability-disabled", () => {
    const handle = legacyHandle(legacyInstance());
    for (const result of [
      handle.guideLayoutCommand("view.newGuideLayout", {}),
      handle.viewCommand("count.add", {}),
      handle.viewSnapshot(),
      handle.samplerReadout(0),
      handle.formatLength(10, "mm"),
      handle.measurementLog(),
      handle.viewPointer("hit-guide", [1, 2]),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.code).toBe("capability-disabled");
      expect(result.ok ? "" : result.message).toContain("编辑内核");
    }
  });

  it("端口存在时正常转发并做有界解码", () => {
    const log = vi.fn(() => JSON.stringify({ rows: [{ id: 1, values: { L: 12 } }], columns: ["L"] }));
    const handle = legacyHandle(legacyInstance({
      guideLayoutCommand: (id: string) => JSON.stringify({ id }),
      viewCommand: (id: string) => (id === "measurementLog.list" ? log() : JSON.stringify({ ok: true })),
      viewSnapshotJson: () => JSON.stringify(snapshot()),
      samplerReadoutJson: () => JSON.stringify({ index: 0, number: 1, position: [1, 2], rgb: [1, 2, 3], cmyk: [0, 0, 0, 100] }),
      formatLengthJson: () => JSON.stringify({ text: "25.4 mm", unit: "mm" }),
    }));
    expect(handle.guideLayoutCommand("view.newGuideLayout", {}).ok).toBe(true);
    expect(handle.viewCommand("count.add", {}).ok).toBe(true);
    const view = handle.viewSnapshot();
    expect(view.ok && view.value.measurement.count.total).toBe(1);
    expect(handle.samplerReadout(0).ok).toBe(true);
    expect(handle.formatLength(72, "mm")).toEqual({ ok: true, value: { text: "25.4 mm", unit: "mm" } });
    expect(handle.measurementLog().ok).toBe(true);
    expect(log).toHaveBeenCalledOnce();
  });

  it("端口存在但返回无效形状时明确失败", () => {
    const handle = legacyHandle(legacyInstance({
      viewSnapshotJson: () => JSON.stringify({}),
      samplerReadoutJson: () => JSON.stringify({ index: 99 }),
      formatLengthJson: () => JSON.stringify({ text: "", unit: "mm" }),
      viewCommand: () => "not-json",
    }));
    expect(handle.viewSnapshot().ok).toBe(false);
    expect(handle.samplerReadout(0).ok).toBe(false);
    expect(handle.formatLength(1, "mm").ok).toBe(false);
    expect(handle.measurementLog().ok).toBe(false);
  });
});

describe("画布指针几何端口", () => {
  function pointerHandle(payload: (action: string) => string) {
    return legacyHandle(legacyInstance({
      viewPointerJson: (action: string, params: string) =>
        payload(action === "hit-guide" && params.includes("\"tolerance\"") ? `${action}:tol` : action),
    }));
  }

  it("三种动作各自解码成稳定的判别名", () => {
    const handle = pointerHandle((action) => {
      if (action.startsWith("hit-guide")) return JSON.stringify({
 locked: false, hit: { vertical: true, index: 1, position: 30, distance: 2.5 } });
      if (action === "drag-guide") return JSON.stringify({
 vertical: true, position: 42.5, locked: false });
      return JSON.stringify({ origin: [5, 6], current: [0, 0] });
    });
    const hit = handle.viewPointer("hit-guide", [30, 20], { tolerance: 6 });
    expect(hit.ok && hit.value).toEqual({
 kind: "hit", locked: false, hit: { vertical: true, index: 1, position: 30, distance: 2.5 } });
    const drag = handle.viewPointer("drag-guide", [30, 20], { vertical: true });
    expect(drag.ok && drag.value).toEqual({
 kind: "drag", vertical: true, position: 42.5, locked: false });
    const origin = handle.viewPointer("drag-origin", [5, 6]);
    expect(origin.ok && origin.value).toEqual({ kind: "origin", origin: [5, 6], current: [0, 0] });
  });

  it("来源视图 id 原样透传给内核（多视图只让活动视图接收输入）", () => {
    const calls: unknown[] = [];
    const handle = legacyHandle(legacyInstance({
      viewPointerJson: (_action: string, params: string) => {
        calls.push(JSON.parse(params));
        return JSON.stringify({
 locked: false, hit: null });
      },
    }));
    handle.viewPointer("hit-guide", [30, 20], { viewId: "view-2" });
    // 端口不自己判断哪个视图是活动的：把来源交给内核复核，界面不复制状态机。
    expect(calls[0]).toEqual({ client: [30, 20], viewId: "view-2" });
    // 不带来源的旧调用方参数形状不变。
    handle.viewPointer("hit-guide", [1, 2]);
    expect(calls[1]).toEqual({ client: [1, 2] });
  });

  it("没命中和锁定都是正常结果，不是失败", () => {
    const handle = pointerHandle((action) =>
      JSON.stringify(action.startsWith("hit-guide")
        ? {
 locked: true, hit: null }
        : {
 vertical: false, position: null, locked: true }));
    const hit = handle.viewPointer("hit-guide", [0, 0]);
    expect(hit.ok && hit.value).toEqual({
 kind: "hit", locked: true, hit: null });
    const drag = handle.viewPointer("drag-guide", [0, 0], { vertical: false });
    expect(drag.ok && drag.value).toEqual({
 kind: "drag", vertical: false, position: null, locked: true });
  });

  it("probe 解码出源像素读数，画布外是「没有读数」而不是 0", () => {
    const inside = pointerHandle(() => JSON.stringify({
      unit: "px",
      reading: { source: [10.5, 20.5], pixel: [10, 20], rgb: [255, 128, 0], cmyk: [0, 50, 100, 0] },
    }));
    const value = inside.viewPointer("probe", [10.5, 20.5]);
    expect(value.ok && value.value).toEqual({
      kind: "probe",
      probe: { unit: "px", reading: { source: [10.5, 20.5], pixel: [10, 20], rgb: [255, 128, 0], cmyk: [0, 50, 100, 0] } },
    });

    const outside = pointerHandle(() => JSON.stringify({ unit: "px", reading: null }));
    const noReading = outside.viewPointer("probe", [-4, 3]);
    expect(noReading.ok ? noReading.value : null).toEqual({ kind: "probe", probe: { unit: "px", reading: null } });

    // 越界通道值、缺字段、无单位都不是可显示的读数：拒绝而不是按 0 显示。
    for (const payload of [
      { unit: "px", reading: { source: [1, 2], pixel: [1, 2], rgb: [256, 0, 0], cmyk: [0, 0, 0, 0] } },
      { unit: "px", reading: { source: [1, 2], pixel: [1, 2], rgb: [0, 0, 0], cmyk: [0, 0, 101, 0] } },
      { unit: "px", reading: { source: [1], pixel: [1, 2], rgb: [0, 0, 0], cmyk: [0, 0, 0, 0] } },
      { unit: "", reading: null },
      { reading: null },
    ]) {
      const handle = pointerHandle(() => JSON.stringify(payload));
      expect(handle.viewPointer("probe", [1, 2]).ok).toBe(false);
    }
  });

  it("动作白名单之外与无效响应都拒绝", () => {
    const handle = pointerHandle(() => JSON.stringify({ hit: { vertical: true, index: -1 } }));
    // 未登记的动作不会送到内核：直接按能力关闭上报。
    const unknown = handle.viewPointer("snap-everything" as never, [0, 0]);
    expect(unknown.ok ? "" : unknown.code).toBe("capability-disabled");
    // 缺 `locked`、索引越界、距离为负都不是可显示的结果。
    expect(handle.viewPointer("hit-guide", [0, 0]).ok).toBe(false);
    const negative = pointerHandle(() => JSON.stringify({
 locked: false, hit: { vertical: true, index: 0, position: 1, distance: -1 } }));
    expect(negative.viewPointer("hit-guide", [0, 0]).ok).toBe(false);
    const noOrigin = pointerHandle(() => JSON.stringify({ origin: [1], current: [0, 0] }));
    expect(noOrigin.viewPointer("drag-origin", [0, 0]).ok).toBe(false);
  });
});
