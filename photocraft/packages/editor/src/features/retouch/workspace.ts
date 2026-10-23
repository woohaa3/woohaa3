import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { FeatureOwner } from "../contracts.js";
import {
  DEFAULT_REGION_OPTIONS,
  DEFAULT_RETOUCH_OPTIONS,
  CLONE_OVERLAY_BLENDS,
  REGION_RETOUCH_COMMANDS,
  clampRetouchOptions,
  cloneOverlayParams,
  cloneSourceResetParams,
  cloneSourceSelectParams,
  cloneSourceSetParams,
  decodeCloneSources,
  decodeHistorySources,
  describeRetouchFailure,
  isRegionRetouchCommand,
  regionParams,
  retouchOptionParams,
  validateRetouchOptions,
  type CloneOverlay,
  type CloneSourceSlot,
  type CloneSourceState,
  type RegionOptions,
  type RetouchCommand,
  type RetouchHistorySource,
  type RetouchOptions,
  type RetouchRegionCommand
} from "./tool-parameters.js";
import { addRedEyePoint, regionGestureFromDrag, type RegionDrag } from "./region-gesture.js";
import {
  activeCloneSlot,
  cloneOverlayCorners,
  cloneOverlayOpacity,
  cloneOverlayScreenCorners,
  cloneOverlayVisible,
  cloneSourcePoint,
  type ScreenPoint
} from "./clone-overlay.js";
import type { DocumentPoint } from "../shared/tool-parameters.js";

/**
 * 修饰域的领域会话（change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 三种事务共用工作区的活动草稿门禁与发布路径，不复制文档/历史：
 * - 笔迹（`beginRetouch`…）：逐帧预览；
 * - 区域（`beginRetouchRegion`…）：先算候选，确认一次；
 * - 只读查询（`retouchHistorySources` / `cloneSources`）：不制造 dirty。
 *
 * 归属：每次开始都固定 `FeatureOwner`（documentId/attemptId）。晚到的追加或确认只有在归属仍
 * 属于**当前文档**时才写入，否则丢弃——不写进后来切换到的文档。修订级的过期判定由内核按
 * `baseRevision` 复核（区域候选），这里只守住文档归属。
 *
 * 工具选项（U39）由本域会话持有：画布手势只给画笔与命令，逐工具参数在这里补齐后才进内核，
 * 因此共享入口不必知道每个工具的参数名。选项是会话偏好，不进入内容指纹。
 */

type Ownership = { owner: FeatureOwner; mode: "stroke" | "region" };

/** 域会话的私有状态：与控制器同生命周期（`createSession` 只调用一次）。 */
export type RetouchSessionState = {
  options: RetouchOptions;
  /** 最近一次使用的历史画笔源索引（面板与落笔共用）。 */
  historySource: number | null;
  /** 画布上已标记、还没计算候选的红眼位置（U37）。 */
  redEye: readonly (readonly [number, number])[];
  /**
   * 已有一份红眼候选在进行中（位置交给内核算候选，但仍要在取消时还回来）。
   *
   * 不设这个标记就只能二选一：候选开始时清空位置（取消后用户得重新点一遍），或一直不清
   * （确认后又把同一处带进下一份候选）。spec 要求取消时「保留可恢复输入」，所以位置留到
   * **确认成功**才清。
   */
  redEyeInFlight: boolean;
  ownership: Ownership | null;
};

function newState(): RetouchSessionState {
  return { options: { ...DEFAULT_RETOUCH_OPTIONS }, historySource: null, redEye: [], redEyeInFlight: false, ownership: null };
}

function documentId(context: WorkspaceFeatureContext): string {
  return String(context.view.document?.name ?? "");
}

function retouch(context: WorkspaceFeatureContext) {
  return context.handle?.features.retouch;
}

function currentOwnership(context: WorkspaceFeatureContext, state: RetouchSessionState): Ownership | null {
  const ownership = state.ownership;
  if (!ownership) return null;
  // 文档已切换：旧归属立即失效（晚到结果不得写入新文档）。
  if (!context.view.hasDocument || ownership.owner.documentId !== documentId(context)) {
    state.ownership = null;
    return null;
  }
  return ownership;
}

function claim(context: WorkspaceFeatureContext, state: RetouchSessionState, mode: "stroke" | "region"): FeatureOwner {
  const attemptId = `retouch-${mode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner: FeatureOwner = { documentId: documentId(context), generation: context.view.document?.revision ?? 0, attemptId };
  state.ownership = { owner, mode };
  return owner;
}

/**
 * 把域选项补进共享入口传来的画笔参数。
 *
 * 共享画布只构造通用笔迹（尺寸/硬度/不透明度/流量/间距），逐工具参数由本域补齐；已显式给出的
 * 键不覆盖，这样面板之外的调用（测试、脚本）仍然可以精确指定参数。键名与上限只有一份：与每次
 * 落笔用的 [`retouchOptionParams`] 同源。
 */
export function applyRetouchOptions(
  command: string,
  params: Record<string, unknown>,
  options: RetouchOptions,
  extras: { historySource?: number | null } = {}
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  // 海绵的 `mode` 是工具语义（增/减饱和），不是混合模式：通用笔迹模板写入的
  // `mode:"normal"` 必须被替换，否则内核报 unknown mode 并让编辑器落进错误边界。
  if (command === "paint.sponge" && (next.mode === undefined || next.mode === "normal")) {
    next.mode = options.spongeMode;
  }
  const defaults = retouchOptionParams(command, options);
  if (command === "paint.historyBrush" && extras.historySource !== undefined) {
    // 面板选择的历史源优先于通用选项（历史源属于文档状态，不是工具偏好）。
    defaults.state = extras.historySource ?? options.historyState;
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined) next[key] = value;
  }
  return next;
}

/**
 * 把共享画笔的 0–1 小数字段换成内核修饰命令要求的 0–100 百分比。
 *
 * 上游 `retouch_cmds::stroke_brush` 对 `hardness/opacity/flow` 一律按**百分比**处理
 * （`clamp(lo, hi) / 100.0`，且 opacity / flow 的下限是 1）：它和 `paint.stroke` 不是同一套
 * 单位。共享画布只产出一份通用笔迹（`buildStroke`，0–1，见 `painting/tool-parameters.ts`），
 * 直接透传会让修饰笔迹的有效不透明度落到 1%，界面表现是「落笔了、也是一步历史，但几乎没变化」
 * ——真实缺陷：模糊/锐化/涂抹/减淡/加深/海绵/污点修复在 UI 里全部看不出效果。
 *
 * 只在**本域入口**换算，且只换算 `<= 1` 的值：共享画笔里 1 表示满值，而百分比里 1 表示 1%。
 * 显式给出 0–100 的调用方（脚本、内核测试、面板之外的集成）保持原值，不做二次放大。
 */
function toRetouchPercent(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value <= 1 ? value * 100 : value;
}

function normalizeBrushUnits(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  for (const key of ["hardness", "opacity", "flow"] as const) {
    const value = next[key];
    if (typeof value === "number") next[key] = toRetouchPercent(value);
  }
  return next;
}

/** 需要取样源的笔迹命令；取样点必须落在当前文档内。 */
const SOURCED_COMMANDS = new Set(["paint.cloneStamp", "paint.healingBrush"]);

/**
 * 取样源是否已失效（取样点是**文档坐标**，换到更小的文档后就可能在画布之外）。
 *
 * 设计 D2 要求「仿制/修复来源包含 documentId/generation，外部来源失效时落笔前提示重取样」。
 * 上游对越界采样点是静默钳制：整笔零像素变化，却仍新增一条历史，界面也没有任何提示——
 * 用户以为仿制生效了。这里在开始前就拒绝并说明要重新取样，不提交半成品。
 *
 * 校验的是**这一笔真正会用的源**：笔迹参数里的 `source` 优先；没有时才取会话活动槽位的源
 * （与内核 `clone_source::resolve` 同序）。只看参数会漏掉「切到更小的文档、槽位还留着旧点」
 * 这条路——那才是换文档后最容易踩到的情形。
 */
function staleSourceReason(
  context: WorkspaceFeatureContext,
  id: string,
  base: Record<string, unknown>
): string | null {
  const document = context.view.document;
  if (!document) return null;
  const explicit = base.source;
  let point: readonly [number, number] | null = null;
  if (Array.isArray(explicit) && explicit.length >= 2) {
    const [x, y] = explicit.map((value) => Number(value));
    if (Number.isFinite(x) && Number.isFinite(y)) point = [x, y];
  } else {
    const listed = cloneSources(context);
    if (!listed.ok) return null;
    const slot = activeCloneSlot(listed.value.slots, listed.value.active);
    point = slot?.source ?? null;
  }
  if (!point) return null;
  const [x, y] = point;
  if (x >= 0 && y >= 0 && x <= document.width && y <= document.height) return null;
  return `取样点 (${Math.round(x)}, ${Math.round(y)}) 不在当前文档内（${document.width}×${document.height}），`
    + `可能来自已切换或已关闭的文档；请重新 Alt+单击取样（${id === "paint.healingBrush" ? "修复画笔" : "仿制图章"}）`;
}

function beginStroke(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  id: string,
  params: unknown
): EditorResult<unknown> {
  const feature = retouch(context);
  if (!feature) return context.unavailable();
  if (isRegionRetouchCommand(id)) {
    return { ok: false, code: "unsupported-command", message: `${id} 是区域修饰命令，请使用区域入口` };
  }
  if (context.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结束当前操作" };
  const invalid = validateRetouchOptions(id, state.options);
  if (invalid) return { ok: false, code: "invalid-params", message: invalid };
  const base = normalizeBrushUnits((params && typeof params === "object" ? params : {}) as Record<string, unknown>);
  if (SOURCED_COMMANDS.has(id)) {
    const stale = staleSourceReason(context, id, base);
    if (stale) return { ok: false, code: "invalid-params", message: stale };
  }
  const merged = applyRetouchOptions(id, base, state.options, { historySource: state.historySource });
  const result = feature.beginRetouch(id, merged);
  if (!result.ok) return context.fail(result);
  context.retouchActive = true;
  claim(context, state, "stroke");
  return result;
}

function appendStroke(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  points: unknown
): EditorResult<unknown> {
  const feature = retouch(context);
  if (!feature || !context.retouchActive) return context.unavailable();
  const ownership = currentOwnership(context, state);
  if (!ownership || ownership.mode !== "stroke") {
    // 晚到追加：归属已不属于当前文档/当前事务，丢弃而不写进别的文档。
    context.retouchActive = false;
    return { ok: false, code: "gesture-active", message: "修饰归属已失效，请重新开始" };
  }
  const result = feature.appendRetouch(points);
  return result.ok ? result : context.fail(result);
}

function commitStroke(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState
): EditorResult<EditorViewModel> {
  const feature = retouch(context);
  if (!feature || !context.retouchActive) return context.unavailable();
  const ownership = currentOwnership(context, state);
  context.retouchActive = false;
  if (!ownership || ownership.mode !== "stroke") {
    feature.cancelRetouch();
    state.ownership = null;
    return { ok: false, code: "gesture-active", message: "修饰归属已失效，已取消这一笔" };
  }
  const result = feature.commitRetouch();
  state.ownership = null;
  if (!result.ok) {
    feature.cancelRetouch();
    return context.fail(result);
  }
  return context.afterWrite();
}

function cancel(context: WorkspaceFeatureContext, state: RetouchSessionState): void {
  const feature = retouch(context);
  const ownership = currentOwnership(context, state);
  if (context.retouchActive && feature) {
    if (ownership?.mode === "region") feature.cancelRetouchRegion();
    else feature.cancelRetouch();
  }
  context.retouchActive = false;
  state.ownership = null;
}

function beginRegion(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  id: string,
  params: unknown
): EditorResult<unknown> {
  const feature = retouch(context);
  if (!feature) return context.unavailable();
  if (!isRegionRetouchCommand(id)) {
    return { ok: false, code: "unsupported-command", message: `${id} 不是区域修饰命令` };
  }
  if (context.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结束当前操作" };
  const result = feature.beginRetouchRegion(id, params);
  if (!result.ok) return context.fail(result);
  context.retouchActive = true;
  claim(context, state, "region");
  return result;
}

function commitRegion(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState
): EditorResult<EditorViewModel> {
  const feature = retouch(context);
  if (!feature || !context.retouchActive) return context.unavailable();
  const ownership = currentOwnership(context, state);
  context.retouchActive = false;
  if (!ownership || ownership.mode !== "region") {
    feature.cancelRetouchRegion();
    state.ownership = null;
    return { ok: false, code: "gesture-active", message: "修饰归属已失效，已丢弃候选" };
  }
  const result = feature.commitRetouchRegion();
  state.ownership = null;
  if (!result.ok) {
    feature.cancelRetouchRegion();
    return context.fail(result);
  }
  // 确认成功才丢掉红眼标记，避免同一处被下一次候选重复带入。
  if (state.redEyeInFlight) {
    state.redEye = [];
    state.redEyeInFlight = false;
  }
  return context.afterWrite();
}

function cancelRegion(context: WorkspaceFeatureContext, state: RetouchSessionState): void {
  if (context.retouchActive) retouch(context)?.cancelRetouchRegion();
  context.retouchActive = false;
  state.ownership = null;
  // 已标记的红眼位置保留：取消只丢弃候选，不能连用户的输入一起丢掉。
  state.redEyeInFlight = false;
}

function historySources(context: WorkspaceFeatureContext): EditorResult<RetouchHistorySource[]> {
  const feature = retouch(context);
  if (!feature) return context.unavailable();
  const result = feature.retouchHistorySources();
  if (!result.ok) return context.fail(result);
  return { ok: true, value: decodeHistorySources(result.value) };
}

/** 五槽仿制源与叠加选项（只读查询；不存在文档时返回失败而不是空列表）。 */
function cloneSources(context: WorkspaceFeatureContext): EditorResult<CloneSourceState> {
  const handle = context.handle;
  if (!handle) return context.unavailable();
  // 优先走域端口：它查会话 presets，落笔期间也能读到取景（叠加取样框要用）。旧宿主没有
  // 这个导出时回退到 `execute`，落笔中会被共享草稿门禁拒绝，界面显示具体原因而不是空列表。
  const feature = retouch(context);
  const result = feature?.retouchCloneSources
    ? feature.retouchCloneSources()
    : handle.execute("cloneSource.list");
  if (!result.ok) return context.fail(result);
  const decoded = decodeCloneSources(result.value);
  if (!decoded) return { ok: false, code: "invalid-message", message: "仿制源结构非法" };
  return { ok: true, value: decoded };
}

/**
 * 从画布拖动直接开始一次区域修饰（U37）。
 *
 * 共享画布只提供文档坐标的起点/终点；偏移换算、零偏移拒绝与选项校验都由
 * [`regionGestureFromDrag`] + [`regionParams`] 完成，和面板走同一条路径。红眼不是拖动，
 * 走 [`markRedEye`] 追加位置后再 `beginRetouch` 的同族入口。
 */
function beginRegionDrag(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  id: RetouchRegionCommand,
  drag: RegionDrag | null,
  options: RegionOptions = DEFAULT_REGION_OPTIONS
): EditorResult<unknown> {
  const computed = regionGestureFromDrag(id, drag, options);
  if ("reason" in computed) return { ok: false, code: "invalid-params", message: computed.reason };
  const params = regionParams(id, options, computed.gesture);
  if (!params) return { ok: false, code: "invalid-params", message: "区域参数不完整" };
  return beginRegion(context, state, id, params);
}

/** 已标记但还没计算的红眼位置（画布单击/框选累积）。 */
function markRedEye(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  point: DocumentPoint | null
): EditorResult<readonly (readonly [number, number])[]> {
  // 候选进行中不能再改位置：候选用的点集已经交给内核，此时追加会让面板显示的数量与
  // 实际候选不一致（取消后保留位置的修复也会因此带进多余的点）。
  if (context.retouchActive) {
    return { ok: false, code: "gesture-active", message: "候选进行中：请先确认或取消这一份红眼候选" };
  }
  const marks = addRedEyePoint(state.redEye, point);
  if (marks.reason) return { ok: false, code: "invalid-params", message: marks.reason };
  state.redEye = marks.points;
  return { ok: true, value: marks.points };
}

/** 用已标记的位置开始红眼候选；位置为空时明确拒绝，不发一次空命令。 */
function beginRedEye(
  context: WorkspaceFeatureContext,
  state: RetouchSessionState,
  options: RegionOptions = DEFAULT_REGION_OPTIONS
): EditorResult<unknown> {
  if (state.redEye.length === 0) {
    return { ok: false, code: "invalid-params", message: "请先在画布上标出红眼位置" };
  }
  const params = regionParams("paint.redEye", options, { points: state.redEye });
  if (!params) return { ok: false, code: "invalid-params", message: "红眼参数不完整" };
  const result = beginRegion(context, state, "paint.redEye", params);
  // 位置交给内核候选后**先留着**：确认成功才清（否则取消一次就要用户重新点一遍位置，
  // 与 spec「取消时保留可恢复输入」相反）。候选进行中面板按钮全部禁用，不会重复带入。
  if (result.ok) state.redEyeInFlight = true;
  return result;
}

/**
 * 仿制源叠加层要画的取样框（U39）。
 *
 * 共享画布给出文档→客户坐标换算，本域给出与落笔同一份映射；返回 `null` 表示这一帧不画
 * （选项关闭、没有取样点、或落笔时自动隐藏）。
 */
function cloneOverlayFrame(
  context: WorkspaceFeatureContext,
  size: number,
  stroking: boolean,
  toScreen: (point: DocumentPoint) => ScreenPoint | null
): EditorResult<{ corners: ScreenPoint[]; opacity: number; invert: boolean } | null> {
  const listed = cloneSources(context);
  if (!listed.ok) return listed;
  const slot = activeCloneSlot(listed.value.slots, listed.value.active);
  if (!cloneOverlayVisible(listed.value.overlay, slot, stroking) || !slot) return { ok: true, value: null };
  const corners = cloneOverlayScreenCorners(slot, size, listed.value.overlay.clipped, toScreen);
  if (!corners) return { ok: true, value: null };
  return {
    ok: true,
    value: { corners, opacity: cloneOverlayOpacity(listed.value.overlay), invert: listed.value.overlay.invert }
  };
}

function cloneCommand(
  context: WorkspaceFeatureContext,
  id: string,
  params: Record<string, unknown>
): EditorResult<unknown> {
  const handle = context.handle;
  if (!handle) return context.unavailable();
  const result = handle.execute(id, params);
  return result.ok ? result : context.fail(result);
}

export function createSession(context: () => WorkspaceFeatureContext) {
  const state = newState();
  return {
    beginRetouch: (id: string, params: unknown) => beginStroke(context(), state, id, params),
    appendRetouch: (points: unknown) => appendStroke(context(), state, points),
    commitRetouch: () => commitStroke(context(), state),
    cancelRetouch: () => cancel(context(), state),
    hasRetouch: () => context().retouchActive,
    beginRetouchRegion: (id: RetouchRegionCommand | string, params: unknown) => beginRegion(context(), state, id, params),
    commitRetouchRegion: () => commitRegion(context(), state),
    cancelRetouchRegion: () => cancelRegion(context(), state),
    /** 画布拖动直接开始区域修饰（修补／内容识别移动）；红眼走 markRedEye + beginRedEye。 */
    beginRetouchRegionDrag: (
      id: RetouchRegionCommand,
      drag: RegionDrag | null,
      options: Partial<RegionOptions> = {}
    ) => beginRegionDrag(context(), state, id, drag, { ...DEFAULT_REGION_OPTIONS, ...options }),
    /** 标记一处红眼位置（画布单击/框选）。 */
    markRedEye: (point: DocumentPoint | null) => markRedEye(context(), state, point),
    /** 已标记的红眼位置（只读快照）。 */
    redEyePoints: () => [...state.redEye],
    /** 清空已标记的红眼位置。 */
    clearRedEye: () => {
      state.redEye = [];
      state.redEyeInFlight = false;
      return 0;
    },
    /** 用已标记位置开始红眼候选。 */
    beginRedEye: (options: Partial<RegionOptions> = {}) =>
      beginRedEye(context(), state, { ...DEFAULT_REGION_OPTIONS, ...options }),
    /** 仿制源叠加取样框（与落笔同一份映射；`null` 表示这一帧不画）。 */
    cloneOverlayFrame: (size: number, stroking: boolean, toScreen: (point: DocumentPoint) => ScreenPoint | null) =>
      cloneOverlayFrame(context(), size, stroking, toScreen),
    retouchHistorySources: () => historySources(context()),
    retouchOwnership: () => currentOwnership(context(), state)?.owner ?? null,
    /**
     * 当前是否有一个「区域候选」尚未确认/取消。
     *
     * 画布拖动也能直接生成候选（`beginRetouchRegionDrag`），此时面板里本地的 `active` 还是
     * false，「确认」按钮会一直不可按。面板据此读回域会话的真值，两条入口共用同一个状态。
     */
    retouchRegionActive: () => currentOwnership(context(), state)?.mode === "region",
    retouchOptions: () => ({ ...state.options }),
    setRetouchOptions: (patch: Partial<RetouchOptions>) => {
      state.options = clampRetouchOptions({ ...state.options, ...patch });
      return { ...state.options };
    },
    selectHistorySource: (index: number) => {
      state.historySource = Number.isFinite(index) ? Math.max(0, Math.round(index)) : null;
      state.options = clampRetouchOptions({ ...state.options, historyState: state.historySource ?? 0 });
      return state.historySource;
    },
    cloneSources: () => cloneSources(context()),
    selectCloneSource: (index: number) => cloneCommand(context(), "cloneSource.select", cloneSourceSelectParams(index)),
    setCloneSource: (index: number, patch: Partial<Omit<CloneSourceSlot, "index">> & { clear?: boolean }) =>
      cloneCommand(context(), "cloneSource.set", cloneSourceSetParams(index, patch)),
    resetCloneSourceTransform: (index: number) => cloneCommand(context(), "cloneSource.resetTransform", cloneSourceResetParams(index)),
    /**
     * 叠加选项。未知混合模式**显式拒绝**：早先把它从参数里悄悄删掉再发一条空补丁，内核回
     * 「成功」而界面毫无变化，用户以为已生效。这里给出可操作原因，让面板显示出来。
     */
    setCloneOverlay: (patch: Partial<CloneOverlay>) => {
      if (patch.blend !== undefined && !CLONE_OVERLAY_BLENDS.includes(patch.blend)) {
        return {
          ok: false as const,
          code: "invalid-params",
          message: `叠加混合模式 ${patch.blend} 不受支持（${CLONE_OVERLAY_BLENDS.join("|")}）`
        };
      }
      return cloneCommand(context(), "cloneSource.overlay", cloneOverlayParams(patch));
    },
    retouchCommands: REGION_RETOUCH_COMMANDS,
    describeRetouchFailure,
    /** 当前画笔命令要补的逐工具参数（面板预览与测试共用，不发起调用）。 */
    strokeParamsFor: (command: RetouchCommand, params: Record<string, unknown> = {}) =>
      applyRetouchOptions(command, params, state.options, { historySource: state.historySource })
  };
}

export type RetouchSession = ReturnType<typeof createSession>;

export { addRedEyePoint, cloneOverlayCorners, cloneOverlayVisible, cloneSourcePoint, regionGestureFromDrag };
export type { RegionDrag, ScreenPoint };
