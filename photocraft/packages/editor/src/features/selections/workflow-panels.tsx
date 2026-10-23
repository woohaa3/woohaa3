import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { isRecord } from "../shared/panels.js";
import {
  LassoAnchors,
  REFINE_OUTPUTS,
  clampMaskDensity,
  clampMaskFeather,
  colorGrowParams,
  colorRangeParams,
  decodeDraftState,
  isStaleResult,
  decodeMaskProperties,
  layerMaskEditParams,
  magneticLassoParams,
  maskViewParams,
  normalizeSelectionName,
  quickMaskStrokeParams,
  refineEdgeParams,
  refineEffectiveOutput,
  refineOutputOpensDocument,
  refineOutputUpgraded,
  selectLineParams,
  smartSelectParams,
  type ColorRangePreset,
  type LineAxis,
  type MaskProperties,
  type RefineEdgeInput,
  type RefineOutput,
  type SamplePoint,
  type SelectionMode,
  type SmartSelectKind
} from "./draft-state.js";
import { armCanvasPick, canvasPickOf, disarmCanvasPick } from "./canvas-pick.js";

/**
 * 域会话句柄（`controller.features.selections`）。
 *
 * U17–U24 的入口都挂在本域会话上，不改共享 `editor-workspace.ts` 的方法表：装配槽位由结构
 * 前置提供，域自己扩展适配层。测试替身可能只装配部分能力，所以这里做一次存在性检查，
 * 缺能力就不渲染面板（design D11），而不是调用时抛错。
 */
type SelectionSession = EditorWorkspaceController["features"]["selections"];

function selectionSession(controller: EditorWorkspaceController): SelectionSession | null {
  const session = (controller as { features?: { selections?: unknown } }).features?.selections;
  return session && typeof session === "object" ? (session as SelectionSession) : null;
}

/** 面板自己需要的入口是否都在；缺失时整块不渲染（design D11）。 */
function hasEntries(session: SelectionSession | null, ...names: readonly (keyof SelectionSession)[]): session is SelectionSession {
  return session !== null && names.every((name) => typeof (session as Record<string, unknown>)[name] === "function");
}

/** 读取一次草稿回执里的 `bounds`/`outline`（内核 JSON，结构非法时忽略）。 */
function draftInfo(value: unknown): { bounds: number[] | null; outline: number[][] | null; invalid: boolean } {
  if (!isRecord(value)) return { bounds: null, outline: null, invalid: false };
  const bounds = Array.isArray(value.bounds) && value.bounds.length === 4 ? value.bounds as number[] : null;
  const outline = Array.isArray(value.outline)
    ? (value.outline as unknown[]).filter((segment): segment is number[] => Array.isArray(segment) && segment.length === 4)
    : null;
  // 内核用 `invalid` 表示"最后一次输入非法"：此时禁止确认上一份成功候选。
  return { bounds, outline, invalid: value.invalid === true };
}

function SelectionModeSelect({ value, disabled, onChange }: { value: SelectionMode; disabled: boolean; onChange: (mode: SelectionMode) => void }) {
  return (
    <label>
      运算
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value as SelectionMode)}>
        <option value="replace">替换</option>
        <option value="add">增加</option>
        <option value="subtract">减去</option>
        <option value="intersect">相交</option>
      </select>
    </label>
  );
}

/**
 * 内核里已打开的草稿。
 *
 * 面板会随菜单切换重新挂载，但草稿仍由内核持有；重新挂载时必须先认领它，否则再次 `begin`
 * 会被统一草稿门禁拒绝（"已有活动选区草稿"），用户看到的是"按钮没反应"。
 *
 * `stale` 表示草稿属于别的活动文档（切标签/父子回写后）：仍然认领，避免卡住统一门禁，
 * 但一律按"不可确认"处理，只能取消后重开——绝不把 A 的候选写进 B。
 */
function readDraft(session: SelectionSession): { kind: string | null; bounds: number[] | null; invalid: boolean; stale: boolean } {
  const empty = { kind: null, bounds: null, invalid: false, stale: false };
  if (typeof session.draftState !== "function") return empty;
  const result = session.draftState();
  const decoded = result.ok ? decodeDraftState(result.value) : null;
  if (!decoded || !decoded.active) return empty;
  return { kind: decoded.kind, bounds: decoded.bounds, invalid: decoded.invalid, stale: decoded.stale };
}

/**
 * 内核为当前草稿算出的真实边界段（`[x0,y0,x1,y1]`）。
 *
 * 与确认后交给画布的是同一份候选：磁性套索必须能看出"沿哪条边缘走"，只看包围盒无法判断。
 * 缺导出或读失败时返回空数组，面板退回只显示包围盒，不假装有预览。
 */
function readOutline(session: SelectionSession): number[][] {
  if (typeof session.draftOutline !== "function") return [];
  const result = session.draftOutline();
  if (!result.ok || !Array.isArray(result.value)) return [];
  return (result.value as unknown[])
    .filter((segment): segment is number[] =>
      Array.isArray(segment) && segment.length === 4 && segment.every((value) => typeof value === "number" && Number.isFinite(value)))
    .map((segment) => segment.slice(0, 4));
}

/**
 * 快速蒙版叠色（U20「覆盖色查看」）：`{color, opacity, indicates}` 来自内核候选文档里的临时通道。
 *
 * 读取失败或缺字段时返回 `null`，面板不编一个默认色冒充——叠色是真值还是没读到必须能分辨。
 */
function readQuickMaskOverlay(session: SelectionSession): { color: string; opacity: number; indicates: string } | null {
  if (typeof session.draftState !== "function") return null;
  const result = session.draftState();
  if (!result.ok || !isRecord(result.value)) return null;
  const draft = (result.value as Record<string, unknown>).draft;
  if (!isRecord(draft) || !isRecord(draft.overlay)) return null;
  const overlay = draft.overlay;
  if (typeof overlay.color !== "string" || typeof overlay.opacity !== "number") return null;
  return {
    color: overlay.color,
    opacity: Math.max(0, Math.min(1, overlay.opacity)),
    indicates: overlay.indicates === "selectedAreas" ? "selectedAreas" : "maskedAreas"
  };
}

/** 内核报出的临时笔迹笔数（`draft.strokes`）；读不到时报 0，不编一个递增计数。 */
function readQuickMaskStrokes(session: SelectionSession): number {
  if (typeof session.draftState !== "function") return 0;
  const result = session.draftState();
  if (!result.ok || !isRecord(result.value)) return 0;
  const draft = (result.value as Record<string, unknown>).draft;
  return isRecord(draft) && typeof draft.strokes === "number" ? draft.strokes : 0;
}

/** 认领草稿时的统一提示：过期归属优先于"最后一次输入非法"。 */
const STALE_DRAFT_MESSAGE = "活动文档已切换，这份草稿属于之前的文档；请取消后重新打开";

/** 解析"每行 x,y"的笔迹/锚点输入；非法返回 `null`。 */
function parsePoints(text: string): { x: number; y: number }[] | null {
  const points: { x: number; y: number }[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length !== 2) return null;
    const [x, y] = parts.map((part) => Number(part.trim()));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
  }
  return points.length ? points : null;
}

function DraftBounds({ bounds, invalid }: { bounds: number[] | null; invalid: boolean }) {
  if (!bounds) return null;
  return (
    <span className="photo-editor__option-hint">
      候选 {bounds.map((value) => Math.round(value)).join(", ")}{invalid ? "（最后一次输入非法，修正后才能确认）" : ""}
    </span>
  );
}

/**
 * 草稿的真实追踪轮廓（U18 spec：预览必须使用实际追踪结果，而不是只看包围盒）。
 *
 * 段是 `[x0, y0, x1, y1]` 的文档坐标；这里按候选边界归一化成一个 SVG，让锚点序列被内核追成
 * 什么形状、在哪里收边都看得见。段来自 `draftOutline`（内核的 `selectionDraftOutlineJson`），与确认后写入的是同一份候选。
 */
/** 预览里最多画多少段：细碎选区可能有上万段，整份塞进 SVG 会让面板卡住。 */
const DRAFT_OUTLINE_LIMIT = 600;

function DraftOutline({ outline, bounds }: { outline: readonly number[][]; bounds: number[] | null }) {
  if (!bounds || outline.length === 0) return null;
  const [bx, by, bw, bh] = bounds;
  const pad = 1;
  const viewBox = `${bx - pad} ${by - pad} ${Math.max(1, bw) + pad * 2} ${Math.max(1, bh) + pad * 2}`;
  const shown = outline.slice(0, DRAFT_OUTLINE_LIMIT);
  return (
    <>
      <svg className="photo-editor__draft-outline" data-draft-outline={outline.length}
        viewBox={viewBox} role="img" aria-label="候选轮廓预览"
        style={{ width: "100%", maxHeight: 140, background: "var(--photo-editor__surface-sunken, #1b1b1b)" }}>
        {shown.map((segment, index) => (
          <line key={index} x1={segment[0]} y1={segment[1]} x2={segment[2]} y2={segment[3]}
            stroke="#7fd1ff" strokeWidth={Math.max(0.5, Math.min(bw, bh) / 120)} strokeLinecap="round" />
        ))}
      </svg>
      {/* 截断要说明，不能让人以为预览就是全部轮廓。 */}
      {outline.length > shown.length
        ? <span className="photo-editor__option-hint">轮廓共 {outline.length} 段，预览只画前 {shown.length} 段</span>
        : null}
    </>
  );
}

/** 过期归属的草稿：显示提示，且确认按钮必须禁用。 */
function StaleDraftNote({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return <p className="photo-editor__brush-note photo-editor__brush-note--error">{STALE_DRAFT_MESSAGE}</p>;
}

// ------------------------------------------------------------------ U17 单行/单列

/** 单行/单列选框：一次命中一步历史，不进入草稿。 */
export function LineSelectionPanel({ controller, readonly, canvas, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  canvas: { width: number; height: number };
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [axis, setAxis] = useState<LineAxis>("row");
  const [position, setPosition] = useState(0);
  const [mode, setMode] = useState<SelectionMode>("replace");
  const [message, setMessage] = useState<string | null>(null);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // spec 要求"缩放后单击形成准确的一源像素行/列"：布防后画布下一次单击即落成一行/列。
  // 冻结的工具清单不允许新增 singleRow/singleColumn 工具 id，所以用待命状态表达"子工具"。
  //
  // 待命真值由**画布那条路径**消费（`takeCanvasPick` 会就地解除），面板不能另存一份布尔值：
  // 否则单击落完之后面板仍显示"已布防"，用户会以为要点第二次。这里每次渲染都读回真值，
  // 只在面板自己改状态时补一次重渲染。
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((value) => value + 1);
  if (!hasEntries(session, "selectLine")) return null;
  const armedPick = canvasPickOf(controller);
  const armed = armedPick?.kind === "line" ? armedPick.axis : null;
  const arm = (next: LineAxis) => {
    armCanvasPick(controller, { kind: "line", axis: next }, (point) => {
      // 落点参数与面板"建立一像素行/列"同一个编译器；图外单击在这里就被拒绝。
      const params = selectLineParams(point, { line: next, mode, canvas });
      const result = params ? session.selectLine(params) : null;
      setMessage(params ? (result && !result.ok ? result.message : null) : "单击点在画布外，未建立单行/单列选区");
      if (result?.ok) {
        const payload: unknown = result.value;
        setBounds(isRecord(payload) && Array.isArray(payload.bounds) ? payload.bounds as number[] : null);
        onChanged();
      }
      rerender();
    });
    setMessage(null);
    rerender();
  };
  const disarm = () => {
    disarmCanvasPick(controller);
    rerender();
  };
  const limit = axis === "row" ? canvas.height : canvas.width;
  const apply = () => {
    const point = axis === "row" ? { x: 0, y: position } : { x: position, y: 0 };
    const params = selectLineParams(point, { line: axis, mode, canvas });
    if (!params) {
      setMessage("位置超出画布范围");
      return;
    }
    const result = session.selectLine(params);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    // 单行/单列不进入草稿：边界随命令回执返回（内核按 `[x, y, w, h]` 上报）。
    const payload: unknown = result.value;
    setBounds(isRecord(payload) && Array.isArray(payload.bounds) ? payload.bounds as number[] : null);
    // 面板内建行/列也是一次真实落点，随手解除待命，避免用户以为还有一次"最后一次"。
    disarmCanvasPick(controller);
    onChanged();
  };
  return (
    <section className="photo-editor__advanced-group" aria-label="单行/单列选框" data-line-selection={axis}>
      <span className="photo-editor__options-title">单行 / 单列选框</span>
      <label>
        方向
        <select value={axis} disabled={readonly} onChange={(event) => { setAxis(event.currentTarget.value as LineAxis); setPosition(0); setMessage(null); }}>
          <option value="row">单行</option>
          <option value="column">单列</option>
        </select>
      </label>
      <label>
        {axis === "row" ? "行号" : "列号"}
        <input type="number" min={0} max={Math.max(0, limit - 1)} value={position} disabled={readonly}
          onChange={(event) => setPosition(Math.max(0, Math.min(Math.max(0, limit - 1), Math.floor(Number(event.currentTarget.value) || 0))))} />
      </label>
      <SelectionModeSelect value={mode} disabled={readonly} onChange={setMode} />
      <Button size="sm" disabled={readonly || limit <= 0} onClick={apply}>建立一像素{axis === "row" ? "行" : "列"}</Button>
      {/* spec 的"缩放后单击"路径：布防后用画布单击落点，不必手数行号。 */}
      <Button size="sm" tone={armed === axis ? "neutral" : "ghost"} disabled={readonly || limit <= 0}
        data-line-pick={armed === axis ? "armed" : "idle"} onClick={() => arm(axis)}>
        单击画布放置{axis === "row" ? "单行" : "单列"}
      </Button>
      {armed ? (
        <>
          <span className="photo-editor__option-hint" data-line-pick-armed={armed}>
            下一次画布单击将建立一像素{armed === "row" ? "行" : "列"}（不采用上面的行号/列号）
          </span>
          <Button size="sm" tone="ghost" onClick={disarm}>取消单击放置</Button>
        </>
      ) : null}
      <DraftBounds bounds={bounds} invalid={false} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U18 磁性套索

/** 磁性套索：输入锚点后由内核追踪；预览即候选边界，确认只提交一次。 */
export function MagneticLassoPanel({ controller, readonly, canvas, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  canvas: { width: number; height: number };
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [anchorText, setAnchorText] = useState("10,10\n40,10\n40,40\n10,40");
  const [mode, setMode] = useState<SelectionMode>("replace");
  const [width, setWidth] = useState(10);
  const [contrast, setContrast] = useState(10);
  const [close, setClose] = useState<"magnetic" | "straight">("magnetic");
  // 多边形套索：锚点就是边界（`trace:false`）；磁性套索才由内核沿边缘追踪。
  const [polygon, setPolygon] = useState(false);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // 内核追踪出来的真实边界段（`[x0,y0,x1,y1]`），用于把"追踪结果"画出来而不是只看包围盒。
  const [outline, setOutline] = useState<number[][]>([]);
  const [invalid, setInvalid] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 面板重挂载后继续使用内核里已有的同类草稿（否则再次开始会被统一门禁拒绝）。
  useEffect(() => {
    if (!session) return;
    const draft = readDraft(session);
    if (draft.kind !== "magnetic") return;
    setActive(true);
    setBounds(draft.bounds);
    setOutline(readOutline(session));
    setInvalid(draft.invalid);
    setStale(draft.stale);
  }, [session]);
  if (!hasEntries(session, "beginMagneticLasso", "updateMagneticLasso", "commitSelectionDraft", "cancelSelectionDraft")) return null;

  const preview = () => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    // 非法输入不能确认上一份成功候选：先标记不可提交，再返回原因。
    const reject = (message: string) => {
      setInvalid(active);
      setMessage(message);
    };
    const points = parsePoints(anchorText);
    if (!points) {
      reject("至少需要三个形如 x,y 的锚点");
      return;
    }
    const params = magneticLassoParams(points, { mode, width, contrast, close, trace: !polygon, canvas });
    if (!params) {
      reject("锚点必须落在画布内");
      return;
    }
    const result = active ? session.updateMagneticLasso(params) : session.beginMagneticLasso(params);
    if (!result.ok) {
      setInvalid(active);
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    setInvalid(false);
    const info = draftInfo(result.value);
    setBounds(info.bounds);
    setOutline(readOutline(session));
    setInvalid(info.invalid);
    onChanged();
  };

  /** 文本 ⇄ 锚点模型：回退与闭合判定都走 `LassoAnchors`，与画布手势同一套规则。 */
  const readAnchors = (): LassoAnchors | null => {
    const points = parsePoints(anchorText);
    if (!points) return null;
    const anchors = new LassoAnchors();
    for (const point of points) anchors.append(point);
    return anchors.length ? anchors : null;
  };
  const writeAnchors = (anchors: LassoAnchors) => {
    setAnchorText(anchors.snapshot().map((point) => `${point.x},${point.y}`).join("\n"));
  };

  /** 回退最后一个锚点；仍有可闭合的锚点就按新序列重新追踪，否则标记旧预览不可确认。 */
  const retreat = () => {
    const anchors = readAnchors();
    if (!anchors || !anchors.retreat()) {
      setMessage("没有可回退的锚点");
      return;
    }
    writeAnchors(anchors);
    if (!anchors.canClose()) {
      if (active) setInvalid(true);
      setMessage("锚点不足三个，补齐后才能重新追踪");
      return;
    }
    const params = magneticLassoParams(anchors.snapshot(), { mode, width, contrast, close, trace: !polygon, canvas });
    if (!params) {
      setMessage("锚点必须落在画布内");
      return;
    }
    const result = active ? session.updateMagneticLasso(params) : session.beginMagneticLasso(params);
    if (!result.ok) {
      setInvalid(active);
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    setInvalid(false);
    const info = draftInfo(result.value);
    setBounds(info.bounds);
    setOutline(readOutline(session));
    setInvalid(info.invalid);
    onChanged();
  };

  /** 双击／闭合键的等价入口：三条以上锚点时追踪并一次确认。 */
  const closeAndCommit = () => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const anchors = readAnchors();
    if (!anchors || !anchors.canClose()) {
      setInvalid(active);
      setMessage("至少需要三个锚点才能闭合");
      return;
    }
    const params = magneticLassoParams(anchors.snapshot(), { mode, width, contrast, close, trace: !polygon, canvas });
    if (!params) {
      setInvalid(active);
      setMessage("锚点必须落在画布内");
      return;
    }
    const traced = active ? session.updateMagneticLasso(params) : session.beginMagneticLasso(params);
    if (!traced.ok) {
      setInvalid(active);
      setMessage(traced.message);
      return;
    }
    const committed = session.commitSelectionDraft();
    if (!committed.ok) {
      setMessage(committed.message);
      return;
    }
    setMessage(null);
    setActive(false);
    setBounds(null);
    setInvalid(false);
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="磁性套索" data-magnetic-lasso={active ? "draft" : "idle"}>
      <span className="photo-editor__options-title">{polygon ? "多边形套索" : "磁性套索"}</span>
      <label>
        锚点（每行 x,y）
        <textarea rows={4} value={anchorText} disabled={readonly} onChange={(event) => setAnchorText(event.currentTarget.value)} />
      </label>
      <label>宽度<input type="number" min={1} max={256} value={width} disabled={readonly} onChange={(event) => setWidth(Math.max(1, Math.min(256, Number(event.currentTarget.value) || 10)))} /></label>
      <label>边缘对比<input type="number" min={1} max={100} value={contrast} disabled={readonly} onChange={(event) => setContrast(Math.max(1, Math.min(100, Number(event.currentTarget.value) || 10)))} /></label>
      <label>
        闭合方式
        <select value={close} disabled={readonly || active || polygon} onChange={(event) => setClose(event.currentTarget.value as "magnetic" | "straight")}>
          <option value="magnetic">沿边缘闭合</option>
          <option value="straight">直线闭合</option>
        </select>
      </label>
      <label><input type="checkbox" checked={polygon} disabled={readonly || active} onChange={(event) => setPolygon(event.currentTarget.checked)} />多边形套索（锚点即边界）</label>
      <SelectionModeSelect value={mode} disabled={readonly || active} onChange={setMode} />
      <Button size="sm" disabled={readonly} onClick={preview}>{active ? (polygon ? "重新生成" : "重新追踪") : (polygon ? "预览多边形" : "预览追踪")}</Button>
      <Button size="sm" disabled={readonly} onClick={retreat}>回退锚点</Button>
      <Button size="sm" disabled={readonly || !active || invalid || stale} onClick={() => {
        const result = session.commitSelectionDraft();
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(null);
        setActive(false);
        setBounds(null);
        setOutline([]);
        setInvalid(false);
        setStale(false);
        onChanged();
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => {
        session.cancelSelectionDraft();
        setActive(false);
        setBounds(null);
        setOutline([]);
        setInvalid(false);
        setStale(false);
        setMessage(null);
        onChanged();
      }}>取消</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={closeAndCommit}>闭合完成</Button>
      <DraftBounds bounds={bounds} invalid={invalid} />
      <DraftOutline outline={outline} bounds={bounds} />
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U19 命名选区 / Grow / Similar

/** 命名选区保存/加载：同名覆盖需显式确认。 */
export function NamedSelectionPanel({ controller, readonly, hasSelection, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  hasSelection: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [name, setName] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  if (!hasEntries(session, "saveNamedSelection", "loadNamedSelection")) return null;

  const save = () => {
    const normalized = normalizeSelectionName(name);
    if (!normalized) {
      setMessage("请输入不超过 200 字符的选区名称");
      return;
    }
    const result = session.saveNamedSelection({ name: normalized, overwrite });
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setOverwrite(false);
    onChanged();
  };
  const load = () => {
    const normalized = name.trim();
    const result = session.loadNamedSelection(normalized ? { name: normalized } : {});
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setLoaded(normalized || "selection");
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="命名选区" data-named-selection={loaded ?? "none"}>
      <span className="photo-editor__options-title">命名选区</span>
      <label>
        名称
        <input type="text" value={name} maxLength={200} placeholder="留空则加载进入快速蒙版前的选区" disabled={readonly} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label><input type="checkbox" checked={overwrite} disabled={readonly} onChange={(event) => setOverwrite(event.currentTarget.checked)} />允许覆盖同名通道</label>
      <Button size="sm" disabled={readonly || !hasSelection} onClick={save}>保存选区</Button>
      <Button size="sm" disabled={readonly} onClick={load}>加载选区</Button>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** 按颜色扩大/选取相似（区别于几何 Expand）。 */
export function ColorGrowPanel({ controller, readonly, hasSelection, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  hasSelection: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [tolerance, setTolerance] = useState(32);
  const [sampleAllLayers, setSampleAllLayers] = useState(false);
  const [kind, setKind] = useState<"grow" | "similar">("grow");
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // 真实候选轮廓：Grow 与 Similar 的差别在形状上，只看包围盒容易误判成同一件事。
  const [outline, setOutline] = useState<number[][]>([]);
  const [invalid, setInvalid] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const draft = readDraft(session);
    if (draft.kind !== "grow" && draft.kind !== "similar") return;
    setActive(true);
    setBounds(draft.bounds);
    setOutline(readOutline(session));
    setInvalid(draft.invalid);
    setStale(draft.stale);
    setKind(draft.kind === "similar" ? "similar" : "grow");
  }, [session]);
  if (!hasEntries(session, "beginColorGrow", "updateColorGrow", "commitSelectionDraft", "cancelSelectionDraft")) return null;

  /** 打开时选方式，更新时方式由草稿本身决定（内核拒绝跨种类更新）。 */
  const preview = () => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const params = colorGrowParams(tolerance, sampleAllLayers);
    const result = active ? session.updateColorGrow(params) : session.beginColorGrow(kind === "similar", params);
    if (!result.ok) {
      setInvalid(active);
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    const info = draftInfo(result.value);
    setBounds(info.bounds);
    setOutline(readOutline(session));
    setInvalid(info.invalid);
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="按颜色扩大" data-color-grow={kind}>
      <span className="photo-editor__options-title">按颜色扩大 / 选取相似</span>
      <label>
        方式
        <select value={kind} disabled={readonly || active} onChange={(event) => setKind(event.currentTarget.value as "grow" | "similar")}>
          <option value="grow">扩大选取</option>
          <option value="similar">选取相似</option>
        </select>
      </label>
      <label>容差<input type="number" min={0} max={255} value={tolerance} disabled={readonly} onChange={(event) => setTolerance(Math.max(0, Math.min(255, Number(event.currentTarget.value) || 0)))} /></label>
      <label><input type="checkbox" checked={sampleAllLayers} disabled={readonly} onChange={(event) => setSampleAllLayers(event.currentTarget.checked)} />取样全部图层</label>
      <Button size="sm" disabled={readonly || !hasSelection} onClick={preview}>{active ? "更新预览" : "预览"}</Button>
      <Button size="sm" disabled={readonly || !active || invalid || stale} onClick={() => {
        const result = session.commitSelectionDraft();
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(null);
        setActive(false);
        setBounds(null);
        setOutline([]);
        setInvalid(false);
        setStale(false);
        onChanged();
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => { session.cancelSelectionDraft(); setActive(false); setBounds(null); setOutline([]); setInvalid(false); setStale(false); setMessage(null); onChanged(); }}>取消</Button>
      <DraftBounds bounds={bounds} invalid={invalid} />
      <DraftOutline outline={outline} bounds={bounds} />
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U20 快速蒙版

/** 快速蒙版：进入保留基线，笔迹只写临时通道，退出转选区/取消恢复。 */
export function QuickMaskPanel({ controller, readonly, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  // U20 要求"临时黑白画笔"：快速蒙版里白色=加入选区、黑色=遮出选区（实测确认）。
  // 这里只能是黑/白两档，不是任意颜色；任意色会被内核按灰度阈值吸附，容易让人以为没生效。
  const [color, setColor] = useState("#ffffff");
  const [size, setSize] = useState(40);
  const [pointText, setPointText] = useState("0,0");
  const [message, setMessage] = useState<string | null>(null);
  // 只用来触发重渲染：真值每次渲染都从内核重读，这里不存草稿状态。
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((value) => value + 1);
  if (!hasEntries(session, "beginQuickMask", "paintQuickMask", "exitQuickMask")) return null;

  /**
   * 活跃态/叠色/过期一律**按需读内核**，不在面板里另存一份。
   *
   * 面板此前只在挂载时读一次草稿：用 Q 键（或画布侧任何入口）进入快速蒙版后，面板仍显示
   * "未进入"，用户会以为快捷键没生效而再按一次——那一次恰好是"确认退出"，草稿被静默提交。
   */
  const draft = readDraft(session);
  const active = draft.kind === "quickMask";
  const stale = active && draft.stale;
  const overlay = active ? readQuickMaskOverlay(session) : null;
  const strokes = active ? readQuickMaskStrokes(session) : 0;

  const enter = () => {
    const result = session.beginQuickMask();
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    rerender();
    onChanged();
  };
  const paint = () => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const points = parsePoints(pointText);
    if (!points) { setMessage("笔迹点必须是每行 x,y 的文档坐标"); return; }
    const params = quickMaskStrokeParams(points, { size, color });
    if (!params) { setMessage("笔刷参数非法"); return; }
    const result = session.paintQuickMask(params);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    rerender();
    onChanged();
  };
  const exit = (cancel: boolean) => {
    // 取消任何时候都允许（它只恢复基线）；确认式退出在过期归属下必须先取消。
    if (!cancel && stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const result = session.exitQuickMask(cancel);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    rerender();
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="快速蒙版" data-quick-mask={active ? "active" : "idle"}>
      <span className="photo-editor__options-title">快速蒙版</span>
      <label>
        笔迹
        <select value={color} disabled={readonly || !active} onChange={(event) => setColor(event.currentTarget.value)}>
          <option value="#ffffff">白色（加入选区）</option>
          <option value="#000000">黑色（遮出选区）</option>
        </select>
      </label>
      <label>笔刷大小<input type="number" min={1} max={5000} value={size} disabled={readonly || !active} onChange={(event) => setSize(Math.max(1, Math.min(5000, Number(event.currentTarget.value) || 40)))} /></label>
      {/* U20「覆盖色查看」：把内核真正用的叠色/不透明度/着色侧显示出来，而不是编一个默认色。 */}
      {active && overlay ? (
        <span className="photo-editor__option-hint" data-quick-mask-overlay={overlay.color}>
          覆盖色{" "}
          {overlay.indicates === "selectedAreas" ? "着色选中的一侧" : "着色遮住的一侧"}
          ，{Math.round(overlay.opacity * 100)}%
          {/* 色块带最小可见度，否则 0% 的叠色会变成一块看不见的空白；真实数值由上面的文字报。 */}
          <span style={{ display: "inline-block", width: 12, height: 12, marginLeft: 6, verticalAlign: "-1px",
            background: overlay.color, opacity: Math.max(overlay.opacity, 0.15), border: "1px solid #0006" }} />
        </span>
      ) : null}
      <label>
        笔迹点（每行 x,y）
        <textarea rows={3} value={pointText} disabled={readonly || !active} onChange={(event) => setPointText(event.currentTarget.value)} />
      </label>
      <Button size="sm" disabled={readonly || active} onClick={enter}>进入快速蒙版</Button>
      <Button size="sm" disabled={readonly || !active || stale} onClick={paint}>画入临时通道</Button>
      <Button size="sm" disabled={readonly || !active || stale} onClick={() => exit(false)}>退出并转为选区</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => exit(true)}>取消（恢复进入前）</Button>
      {active ? <span className="photo-editor__option-hint">临时笔迹 {strokes} 笔（只改临时选择通道）</span> : null}
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U21 传统分割

const SMART_KIND_LABELS: Record<SmartSelectKind, string> = {
  object: "对象",
  subject: "主体",
  sky: "天空",
  focusArea: "焦点区域",
  removeBackground: "移除背景"
};

/** 每种传统分割背后的真实命令；用于按运行时能力表决定入口是否可见。 */
const SMART_KIND_COMMANDS: Record<SmartSelectKind, string> = {
  object: "select.object",
  subject: "select.subject",
  sky: "select.sky",
  focusArea: "select.focusArea",
  removeBackground: "layer.removeBackground"
};

/** 传统分割（本地算法）：候选遮罩/选区，确认按选区或蒙版输出。 */
export function SmartSelectPanel({ controller, readonly, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [kind, setKind] = useState<SmartSelectKind>("object");
  const [mode, setMode] = useState<SelectionMode>("replace");
  /**
   * 对象选择的**采样区域**：点选（Object Finder 该点下的对象）或矩形。
   *
   * 上游 `select.object` 两种都收，且结果不同（矩形按整体显著性、点按该点对象）；
   * 只给其中一种等于少交付一半 spec 要求。
   */
  const [region, setRegion] = useState<"point" | "rect">("point");
  const [pointX, setPointX] = useState(0);
  const [pointY, setPointY] = useState(0);
  const [rectX, setRectX] = useState(0);
  const [rectY, setRectY] = useState(0);
  const [rectW, setRectW] = useState(0);
  const [rectH, setRectH] = useState(0);
  const [threshold, setThreshold] = useState(50);
  const [softness, setSoftness] = useState(50);
  // 焦点区域的两档参数（上游 range 0..1、noise 0..1）。
  const [focusRange, setFocusRange] = useState(0.5);
  const [focusNoise, setFocusNoise] = useState(0);
  // 采样层：主体/天空/焦点默认采样所有可见层；对象默认当前层；移除背景只看当前层。
  const [sampleAllLayers, setSampleAllLayers] = useState(true);
  // 输出目标：选区（缺省）或像素蒙版。移除背景本身就是蒙版，故不单独给选项。
  const [output, setOutput] = useState<"selection" | "mask">("selection");
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // 传统分割的候选轮廓：spec 要求"产生可见可修改的实际 mask"，只看包围盒看不出分割边界。
  const [outline, setOutline] = useState<number[][]>([]);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const draft = readDraft(session);
    if (draft.kind !== "smart") return;
    setActive(true);
    setBounds(draft.bounds);
    setOutline(readOutline(session));
    setStale(draft.stale);
  }, [session]);
  if (!hasEntries(session, "beginSmartSelect", "commitSelectionDraft", "cancelSelectionDraft")) return null;

  /**
   * 只列出当前运行时真正允许的传统分割。
   *
   * 入口可见性跟着运行时命令表走，不硬编码"这一版支持哪几种"：能力门没开的种类不渲染，
   * 避免做出"能点但一定失败"的入口；门一开（例如 U21 的主体）这里自动多出选项，面板不用改。
   */
  const commands = controller.snapshot().commands;
  const availableKinds = (Object.keys(SMART_KIND_LABELS) as SmartSelectKind[])
    .filter((id) => commands.get(SMART_KIND_COMMANDS[id])?.allowed);

  /**
   * 切换种类时，把该种类不可用的采样方式收回到它有意义的那个。
   *
   * 矩形采样只属于对象选择；切到别处后仍留在 `rect` 会让参数编译悄悄丢掉采样区域，
   * 用户看到的是"点了预览却按整幅画布分割"。
   */
  const changeKind = (next: SmartSelectKind) => {
    setKind(next);
    setMessage(null);
    if (next !== "object") setRegion("point");
    // 采样层缺省值按种类不同：移除背景默认只看当前层（上游即如此），其余默认全部可见层。
    setSampleAllLayers(next !== "removeBackground");
  };

  const preview = () => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    // 已有候选时"预览"＝用新参数重算。上游 `select.*` 没有 update 变体，只能先丢掉旧候选
    // （它从未写历史）再 begin；否则统一草稿门禁会拒绝第二次 begin，用户改了阈值/采样点却看不到变化。
    if (active) session.cancelSelectionDraft();
    const params = smartSelectParams(kind, {
      mode,
      // 只有对象选择吃采样区域；其余种类的算法自行决定范围，塞进去会被上游忽略。
      ...(kind === "object"
        ? region === "rect"
          ? { rect: [rectX, rectY, rectW, rectH] as [number, number, number, number] }
          : { point: { x: pointX, y: pointY } }
        : {}),
      threshold,
      softness,
      range: focusRange,
      noise: focusNoise,
      // 移除背景由上游固定只看活动层（命令没有采样层选项），显式传会把意图改成"所有层"。
      ...(kind === "removeBackground" ? {} : { sampleAllLayers }),
      output
    });
    const result = session.beginSmartSelect(kind, params);
    if (!result.ok) {
      setMessage(result.message);
      setActive(false);
      return;
    }
    setMessage(null);
    setActive(true);
    setBounds(draftInfo(result.value).bounds);
    setOutline(readOutline(session));
    onChanged();
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="传统对象选择" data-smart-select={kind}>
      <span className="photo-editor__options-title">对象选择（本地传统算法）</span>
      <label>
        方式
        <select value={kind} disabled={readonly} onChange={(event) => changeKind(event.currentTarget.value as SmartSelectKind)}>
          {availableKinds.map((id) => <option key={id} value={id}>{SMART_KIND_LABELS[id]}</option>)}
        </select>
      </label>
      {kind === "object" ? <>
        <label>
          采样区域
          <select value={region} disabled={readonly} onChange={(event) => setRegion(event.currentTarget.value as "point" | "rect")}>
            <option value="point">取样点（该点所在对象）</option>
            <option value="rect">矩形区域</option>
          </select>
        </label>
        {region === "point" ? <>
          <label>取样点 X<input type="number" value={pointX} disabled={readonly} onChange={(event) => setPointX(Math.round(Number(event.currentTarget.value) || 0))} /></label>
          <label>取样点 Y<input type="number" value={pointY} disabled={readonly} onChange={(event) => setPointY(Math.round(Number(event.currentTarget.value) || 0))} /></label>
        </> : <>
          <label>区域 X<input type="number" value={rectX} disabled={readonly} onChange={(event) => setRectX(Math.round(Number(event.currentTarget.value) || 0))} /></label>
          <label>区域 Y<input type="number" value={rectY} disabled={readonly} onChange={(event) => setRectY(Math.round(Number(event.currentTarget.value) || 0))} /></label>
          <label>区域宽<input type="number" min={0} value={rectW} disabled={readonly} onChange={(event) => setRectW(Math.max(0, Math.round(Number(event.currentTarget.value) || 0)))} /></label>
          <label>区域高<input type="number" min={0} value={rectH} disabled={readonly} onChange={(event) => setRectH(Math.max(0, Math.round(Number(event.currentTarget.value) || 0)))} /></label>
          {rectW === 0 || rectH === 0 ? <span className="photo-editor__option-hint">宽高需大于 0 才会按矩形区域取样</span> : null}
        </>}
      </> : null}
      {kind === "sky" ? <>
        <label>阈值<input type="number" min={0} max={100} value={threshold} disabled={readonly} onChange={(event) => setThreshold(Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)))} /></label>
        <label>软化<input type="number" min={0} max={100} value={softness} disabled={readonly} onChange={(event) => setSoftness(Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)))} /></label>
        <span className="photo-editor__option-hint">阈值越高判得越严</span>
      </> : null}
      {kind === "focusArea" ? <>
        <label>范围<input type="number" min={0} max={1} step={0.05} value={focusRange} disabled={readonly} onChange={(event) => setFocusRange(Math.max(0, Math.min(1, Number(event.currentTarget.value) || 0)))} /></label>
        <label>噪点<input type="number" min={0} max={1} step={0.05} value={focusNoise} disabled={readonly} onChange={(event) => setFocusNoise(Math.max(0, Math.min(1, Number(event.currentTarget.value) || 0)))} /></label>
      </> : null}
      {kind === "removeBackground" ? <span className="photo-editor__option-hint">为像素图层添加蒙版，不改像素</span> : (
        <>
          <SelectionModeSelect value={mode} disabled={readonly} onChange={setMode} />
          <label>
            输出
            <select value={output} disabled={readonly} onChange={(event) => setOutput(event.currentTarget.value as "selection" | "mask")}>
              <option value="selection">选区</option>
              <option value="mask">像素蒙版</option>
            </select>
          </label>
        </>
      )}
      {kind === "removeBackground" ? null : (
        <label>
          <input type="checkbox" checked={sampleAllLayers} disabled={readonly} onChange={(event) => setSampleAllLayers(event.currentTarget.checked)} />
          采样所有可见层
        </label>
      )}
      <Button size="sm" disabled={readonly || stale} onClick={preview}>{active ? "更新预览" : "预览候选"}</Button>
      <Button size="sm" disabled={readonly || !active || stale} onClick={() => {
        const result = session.commitSelectionDraft();
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(null);
        setActive(false);
        setBounds(null);
        setOutline([]);
        setStale(false);
        onChanged();
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => { session.cancelSelectionDraft(); setActive(false); setBounds(null); setOutline([]); setStale(false); setMessage(null); onChanged(); }}>取消</Button>
      <DraftBounds bounds={bounds} invalid={false} />
      <DraftOutline outline={outline} bounds={bounds} />
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U22 色彩范围（画布取样 + 高级）

/** 多点/增减取样 + 局部颜色群组 + 色调区间 + 采样层。 */
export function ColorRangeSamplesPanel({ controller, readonly, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [samples, setSamples] = useState<SamplePoint[]>([]);
  const [preset, setPreset] = useState<ColorRangePreset>("sampledColors");
  const [fuzziness, setFuzziness] = useState(40);
  const [localized, setLocalized] = useState(false);
  const [range, setRange] = useState(100);
  const [sampleAllLayers, setSampleAllLayers] = useState(true);
  const [invert, setInvert] = useState(false);
  const [mode, setMode] = useState<SelectionMode>("replace");
  // 色调区间：上游只在 highlights / midtones / shadows 三个预设上读 `tonalRange`。
  // 高光与阴影是单电平（另一端固定 255 / 0），中间调是 [low, high]。
  const [tonalLevel, setTonalLevel] = useState(190);
  const [tonalLow, setTonalLow] = useState(105);
  const [tonalHigh, setTonalHigh] = useState(150);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  // 待命真值由画布那条路径消费并就地解除，面板只读回真值（见 U17 同一机制）。
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((value) => value + 1);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // 真实候选轮廓：色彩范围改一个取样点就该看出边界形状变了，而不只是包围盒数字变。
  const [outline, setOutline] = useState<number[][]>([]);
  const [invalid, setInvalid] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const draft = readDraft(session);
    if (draft.kind !== "colorRange") return;
    setActive(true);
    setBounds(draft.bounds);
    setOutline(readOutline(session));
    setInvalid(draft.invalid);
    setStale(draft.stale);
  }, [session]);
  if (!hasEntries(session, "beginColorRange", "updateColorRange", "commitSelectionDraft", "cancelSelectionDraft")) return null;

  const tonal = preset === "highlights" || preset === "shadows" || preset === "midtones";
  const tonalRange = preset === "midtones" ? ([tonalLow, tonalHigh] as [number, number]) : tonalLevel;

  const preview = (next: SamplePoint[] = samples) => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const params = colorRangeParams({ samples: next, preset, fuzziness, localized, range, sampleAllLayers, invert, mode, tonalRange: tonal ? tonalRange : undefined });
    if (!params) {
      setMessage(localized ? "局部颜色群组需要至少一个取样点" : "请先取样颜色或选择一个范围");
      return;
    }
    const result = active ? session.updateColorRange(params) : session.beginColorRange(params);
    if (!result.ok) {
      setInvalid(active);
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    const info = draftInfo(result.value);
    setBounds(info.bounds);
    setOutline(readOutline(session));
    setInvalid(info.invalid);
    onChanged();
  };

  /** 追加一个取样点：坐标来自手输框或画布单击，走同一个入队与预览路径。 */
  const addSample = (point: SamplePoint["point"], operation: "+" | "-") => {
    const next = [...samples, { point, operation } as SamplePoint];
    setSamples(next);
    preview(next);
  };
  const armedPick = canvasPickOf(controller);
  const armed = armedPick?.kind === "sample" ? armedPick.operation : null;
  const arm = (operation: "+" | "-") => {
    armCanvasPick(controller, { kind: "sample", operation }, (point) => {
      setX(Math.round(point.x));
      setY(Math.round(point.y));
      addSample({ x: point.x, y: point.y }, operation);
      rerender();
    });
    rerender();
  };
  const disarm = () => { disarmCanvasPick(controller); rerender(); };

  return (
    <section className="photo-editor__advanced-group" aria-label="色彩范围取样" data-color-range-samples={samples.length}>
      <span className="photo-editor__options-title">色彩范围（画布取样）</span>
      <div className="photo-editor__advanced-row">
        <label>X<input type="number" value={x} disabled={readonly} onChange={(event) => setX(Math.round(Number(event.currentTarget.value) || 0))} /></label>
        <label>Y<input type="number" value={y} disabled={readonly} onChange={(event) => setY(Math.round(Number(event.currentTarget.value) || 0))} /></label>
      </div>
      <div className="photo-editor__advanced-row">
        <Button size="sm" disabled={readonly} onClick={() => addSample({ x, y }, "+")}>取样 +</Button>
        <Button size="sm" disabled={readonly} onClick={() => addSample({ x, y }, "-")}>减去取样 −</Button>
        <Button size="sm" tone="ghost" disabled={!samples.length} onClick={() => { const next = samples.slice(0, -1); setSamples(next); preview(next); }}>回退取样</Button>
      </div>
      {/* spec 要求"画布多点/增减取样"：布防后在画布上点，点位直接进取样队列，不必手输坐标。 */}
      <div className="photo-editor__advanced-row">
        <Button size="sm" tone={armed === "+" ? "neutral" : "ghost"} disabled={readonly}
          data-color-range-pick={armed === "+" ? "armed" : "idle"} onClick={() => arm("+")}>单击画布加点 +</Button>
        <Button size="sm" tone={armed === "-" ? "neutral" : "ghost"} disabled={readonly}
          data-color-range-pick={armed === "-" ? "armed" : "idle"} onClick={() => arm("-")}>单击画布减点 −</Button>
        {armed ? <Button size="sm" tone="ghost" onClick={disarm}>取消单击取样</Button> : null}
      </div>
      {armed ? <span className="photo-editor__option-hint" data-color-range-pick-armed={armed}>下一次画布单击将{armed === "+" ? "增加" : "减去"}一个取样点</span> : null}
      <label>
        范围
        <select value={preset} disabled={readonly || active} onChange={(event) => {
          const next = event.currentTarget.value as ColorRangePreset;
          setPreset(next);
          // 切换预设时把色调区间拉回该预设的默认电平，避免沿用上一个预设留下的数字。
          if (next === "highlights") setTonalLevel(190);
          if (next === "shadows") setTonalLevel(65);
          if (next === "midtones") { setTonalLow(105); setTonalHigh(150); }
        }}>
          <option value="sampledColors">取样颜色</option>
          <option value="reds">红色</option>
          <option value="yellows">黄色</option>
          <option value="greens">绿色</option>
          <option value="cyans">青色</option>
          <option value="blues">蓝色</option>
          <option value="magentas">洋红</option>
          <option value="highlights">高光</option>
          <option value="midtones">中间调</option>
          <option value="shadows">阴影</option>
          <option value="skinTones">肤色</option>
        </select>
      </label>
      <label>容差<input type="number" min={0} max={200} value={fuzziness} disabled={readonly} onChange={(event) => setFuzziness(Math.max(0, Math.min(200, Number(event.currentTarget.value) || 0)))} /></label>
      <label><input type="checkbox" checked={localized} disabled={readonly} onChange={(event) => setLocalized(event.currentTarget.checked)} />局部颜色群组</label>
      {localized ? <label>群组范围（长边 %）<input type="number" min={0} max={100} value={range} disabled={readonly} onChange={(event) => setRange(Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)))} /></label> : null}
      {tonal ? (
        preset === "midtones" ? (
          <div className="photo-editor__advanced-row" data-color-range-tonal="midtones">
            <label>色调下限<input type="number" min={0} max={255} value={tonalLow} disabled={readonly} onChange={(event) => setTonalLow(Math.max(0, Math.min(255, Math.round(Number(event.currentTarget.value) || 0))))} /></label>
            <label>色调上限<input type="number" min={0} max={255} value={tonalHigh} disabled={readonly} onChange={(event) => setTonalHigh(Math.max(0, Math.min(255, Math.round(Number(event.currentTarget.value) || 0))))} /></label>
          </div>
        ) : (
          <label data-color-range-tonal={preset}>色调区间（0–255）<input type="number" min={0} max={255} value={tonalLevel} disabled={readonly} onChange={(event) => setTonalLevel(Math.max(0, Math.min(255, Math.round(Number(event.currentTarget.value) || 0))))} /></label>
        )
      ) : null}
      <label><input type="checkbox" checked={sampleAllLayers} disabled={readonly} onChange={(event) => setSampleAllLayers(event.currentTarget.checked)} />取样全部图层</label>
      <label><input type="checkbox" checked={invert} disabled={readonly} onChange={(event) => setInvert(event.currentTarget.checked)} />反相</label>
      <SelectionModeSelect value={mode} disabled={readonly || active} onChange={setMode} />
      <Button size="sm" disabled={readonly} onClick={() => preview()}>{active ? "更新预览" : "预览"}</Button>
      <Button size="sm" disabled={readonly || !active || invalid || stale} onClick={() => {
        const result = session.commitSelectionDraft();
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(null);
        setActive(false);
        setBounds(null);
        setOutline([]);
        setInvalid(false);
        setStale(false);
        onChanged();
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => { session.cancelSelectionDraft(); setActive(false); setBounds(null); setOutline([]); setInvalid(false); setStale(false); setMessage(null); onChanged(); }}>取消</Button>
      <DraftBounds bounds={bounds} invalid={invalid} />
      <DraftOutline outline={outline} bounds={bounds} />
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U23 选择并遮住（真实预览）

/** 真实像素边缘预览 + 前景/背景修边笔 + 全部开放输出。 */
export function RefineEdgeWorkspace({ controller, readonly, hasSelection, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  hasSelection: boolean;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [input, setInput] = useState<RefineEdgeInput>({ radius: 2, smartRadius: true, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0, output: "selection", sampleAllLayers: false });
  const [strokes, setStrokes] = useState<{ points: { x: number; y: number }[]; mode: "foreground" | "background" }[]>([]);
  const [strokeText, setStrokeText] = useState("0,0");
  const [strokeSize, setStrokeSize] = useState(20);
  const [active, setActive] = useState(false);
  const [bounds, setBounds] = useState<number[] | null>(null);
  // 真实修边后的候选轮廓：U23 要求"真实像素边缘预览"，只给包围盒看不出边缘被怎么改。
  const [outline, setOutline] = useState<number[][]>([]);
  const [invalid, setInvalid] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 请求序号：晚到的候选不得覆盖更新的预览（design D3）。
  const request = useRef(0);
  const documentView = controller.snapshot().view.document;
  // 文档代际用内核自报的活动文档索引，不能用 `revision`：修订每步都变，会把同文档的预览当换代。
  const documentId = controller.snapshot().view.sessionActiveIndex;

  // 文档换代后重新认领草稿；归属不一致的候选由 `stale` 挡在确认之外。`sessionActiveIndex` 的
  // 真实变化（切标签/新开文档）由内核草稿的 `document`/`stale` 复核，这里只负责重新读一次。
  useEffect(() => {
    if (!documentView) { setActive(false); setBounds(null); setOutline([]); setInvalid(false); setStale(false); return; }
    if (!session) return;
    const draft = readDraft(session);
    if (draft.kind !== "refine") return;
    setActive(true);
    setBounds(draft.bounds);
    setOutline(readOutline(session));
    setInvalid(draft.invalid);
    setStale(draft.stale);
  }, [controller, session, documentId]);

  if (!hasEntries(session, "beginRefineEdge", "updateRefineEdge", "commitSelectionDraft", "cancelSelectionDraft")) return null;

  const preview = (next: RefineEdgeInput = input, nextStrokes = strokes) => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const generation = ++request.current;
    const params = refineEdgeParams({ ...next, strokes: nextStrokes.map((stroke) => ({ ...stroke, size: strokeSize })) });
    const result = active ? session.updateRefineEdge(params) : session.beginRefineEdge(params);
    // 用 `isStaleResult` 而不是就地写比较：这条规则有单测，生产路径必须走同一个判定，
    // 否则"测了 a、跑的是 b"，晚到候选是否丢弃取决于两份实现是否恰好一致。
    if (isStaleResult(generation, request.current)) return;
    if (!result.ok) {
      setInvalid(active);
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setActive(true);
    const info = draftInfo(result.value);
    setBounds(info.bounds);
    setOutline(readOutline(session));
    setInvalid(info.invalid);
    onChanged();
  };

  /** 追加一条修边笔迹：点来自输入框，模式是前景（add）或背景（subtract）。 */
  const addStroke = (mode: "foreground" | "background") => {
    if (stale) { setMessage(STALE_DRAFT_MESSAGE); return; }
    const points = parsePoints(strokeText);
    if (!points) { setMessage("修边笔迹点必须是每行 x,y 的文档坐标"); return; }
    const next = [...strokes, { points, mode }];
    setStrokes(next);
    preview(input, next);
  };

  const output = input.output ?? "selection";

  return (
    <section className="photo-editor__advanced-group" aria-label="选择并遮住工作区" data-refine-workspace={output}>
      <span className="photo-editor__options-title">选择并遮住</span>
      {(["radius", "smooth", "feather", "contrast", "shiftEdge"] as const).map((key) => (
        <label key={key}>
          {{ radius: "半径", smooth: "平滑", feather: "羽化", contrast: "对比度", shiftEdge: "边缘偏移" }[key]}
          <input type="number" value={input[key] ?? 0} disabled={readonly}
            min={key === "shiftEdge" ? -100 : 0}
            max={key === "shiftEdge" ? 100 : key === "feather" ? 1000 : key === "radius" ? 250 : 100}
            onChange={(event) => setInput((current) => ({ ...current, [key]: Number(event.currentTarget.value) || 0 }))} />
        </label>
      ))}
      <label><input type="checkbox" checked={input.smartRadius ?? false} disabled={readonly} onChange={(event) => setInput((current) => ({ ...current, smartRadius: event.currentTarget.checked }))} />智能半径</label>
      <label><input type="checkbox" checked={input.sampleAllLayers ?? false} disabled={readonly} onChange={(event) => setInput((current) => ({ ...current, sampleAllLayers: event.currentTarget.checked }))} />取样全部图层</label>
      <label><input type="checkbox" checked={input.decontaminate ?? false} disabled={readonly} onChange={(event) => setInput((current) => ({ ...current, decontaminate: event.currentTarget.checked }))} />净化颜色</label>
      {input.decontaminate ? <label>净化量<input type="number" min={0} max={100} value={input.amount ?? 100} disabled={readonly} onChange={(event) => setInput((current) => ({ ...current, amount: Number(event.currentTarget.value) || 0 }))} /></label> : null}
      <label>
        输出
        <select value={output} disabled={readonly} onChange={(event) => setInput((current) => ({ ...current, output: event.currentTarget.value as RefineOutput }))}>
          {REFINE_OUTPUTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <div className="photo-editor__advanced-row">
        <label>
          笔迹点（每行 x,y）
          <textarea rows={2} value={strokeText} disabled={readonly} onChange={(event) => setStrokeText(event.currentTarget.value)} />
        </label>
        <label>笔刷大小<input type="number" min={1} max={500} value={strokeSize} disabled={readonly} onChange={(event) => setStrokeSize(Math.max(1, Math.min(500, Number(event.currentTarget.value) || 20)))} /></label>
      </div>
      <div className="photo-editor__advanced-row">
        <Button size="sm" disabled={readonly} onClick={() => addStroke("foreground")}>前景修边笔</Button>
        <Button size="sm" disabled={readonly} onClick={() => addStroke("background")}>背景修边笔</Button>
        <Button size="sm" tone="ghost" disabled={!strokes.length} onClick={() => { const next = strokes.slice(0, -1); setStrokes(next); preview(input, next); }}>撤销笔迹</Button>
      </div>
      <Button size="sm" disabled={readonly || (!hasSelection && !active)} onClick={() => preview()}>{active ? "更新预览" : "预览边缘"}</Button>
      <Button size="sm" disabled={readonly || !active || invalid || stale} onClick={() => {
        const result = session.commitSelectionDraft();
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(null);
        setActive(false);
        setBounds(null);
        setOutline([]);
        setInvalid(false);
        setStale(false);
        onChanged();
      }}>确认输出</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => { session.cancelSelectionDraft(); setActive(false); setBounds(null); setOutline([]); setInvalid(false); setStale(false); setMessage(null); onChanged(); }}>取消</Button>
      {refineOutputOpensDocument(output) ? <span className="photo-editor__option-hint">该输出会新建文档；名额不足时整次拒绝</span> : null}
      {/* 净化颜色需要新像素，上游会把"选区/像素蒙版"升级成"新图层（含蒙版）"。
          不提示的话，用户选了"选区"却发现多出一层、选区为空，会以为输出设置没生效。 */}
      {refineOutputUpgraded(output, input.decontaminate) ? (
        <span className="photo-editor__option-hint" data-refine-output-upgraded={refineEffectiveOutput(output, input.decontaminate)}>
          净化颜色需要新像素：确认后实际按「{REFINE_OUTPUTS.find((entry) => entry.id === refineEffectiveOutput(output, input.decontaminate))?.label}」输出，而不是「{REFINE_OUTPUTS.find((entry) => entry.id === output)?.label}」
        </span>
      ) : null}
      <DraftBounds bounds={bounds} invalid={invalid} />
      <DraftOutline outline={outline} bounds={bounds} />
      <StaleDraftNote stale={stale} />
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ U24 像素蒙版属性

/** density / 非破坏 feather / 独立与覆盖查看。 */
export function LayerMaskPanel({ controller, readonly, layer, onChanged }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  layer: number | null;
  onChanged: () => void;
}) {
  const session = selectionSession(controller);
  const [properties, setProperties] = useState<MaskProperties | null>(null);
  const [density, setDensity] = useState(100);
  const [feather, setFeather] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * 读取失败与\"这个层没有蒙版\"是两件事：目标层被删掉时内核拒绝读取，此时不能退化成
   * 空状态文案（spec U24 要求说明具体原因）。
   */
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const maskSession = hasEntries(session, "layerMaskProperties", "editLayerMask", "viewLayerMask") ? session : null;

  const read = useCallback(() => {
    if (!maskSession) return;
    const result = maskSession.layerMaskProperties(layer ?? undefined);
    if (!result.ok) { setReadFailure(result.message); setProperties(null); return; }
    setReadFailure(null);
    const decoded = decodeMaskProperties(result.value);
    setProperties(decoded);
    setMessage(decoded ? null : "无法读取蒙版属性");
    if (decoded?.mask) { setDensity(decoded.mask.density); setFeather(decoded.mask.feather); }
  }, [maskSession, layer]);

  // 图层或修订变化后重读：重开工程仍能改参数。
  useEffect(() => { read(); }, [read, revision]);

  if (!maskSession) return null;

  const apply = () => {
    const params = layerMaskEditParams({ density, feather, layer: layer ?? undefined });
    if (!params) { setMessage("至少需要密度或羽化"); return; }
    const result = maskSession.editLayerMask(params);
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    setRevision((value) => value + 1);
    onChanged();
  };
  const view = (mode: "off" | "gray" | "overlay") => {
    const result = maskSession.viewLayerMask(maskViewParams(mode, layer ?? undefined));
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    setRevision((value) => value + 1);
    onChanged();
  };
  /**
   * `\` 的等价开关：`layer.toggleMaskOverlay` 是内核的切换命令（同一查看状态，不是内容历史）。
   * 与 `view("overlay")` 的区别只在于它按当前状态取反，所以按钮写"切换"。
   */
  const toggleOverlay = () => {
    const result = controller.dispatch("layer.toggleMaskOverlay", { layer: layer ?? undefined });
    if (!result.ok) { setMessage(result.message); return; }
    setMessage(null);
    setRevision((value) => value + 1);
    onChanged();
  };

  // 读取被拒（例如目标图层已删除）：给出内核原因，不伪装成"没有蒙版"的空状态。
  if (readFailure) {
    return (
      <section className="photo-editor__advanced-group" aria-label="像素蒙版" data-layer-mask="unavailable">
        <span className="photo-editor__options-title">像素蒙版</span>
        <p className="photo-editor__brush-note photo-editor__brush-note--error">{readFailure}</p>
      </section>
    );
  }

  if (!properties?.mask) {
    return (
      <section className="photo-editor__advanced-group" aria-label="像素蒙版" data-layer-mask="none">
        <span className="photo-editor__options-title">像素蒙版</span>
        <p className="photo-editor__option-hint">当前图层没有像素蒙版</p>
        {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
      </section>
    );
  }

  return (
    <section className="photo-editor__advanced-group" aria-label="像素蒙版" data-layer-mask={properties.view ?? "off"}>
      <span className="photo-editor__options-title">像素蒙版</span>
      <label>密度<input type="number" min={0} max={100} value={density} disabled={readonly} onChange={(event) => setDensity(clampMaskDensity(Number(event.currentTarget.value) || 0))} /></label>
      <label>羽化（源像素）<input type="number" min={0} max={1000} value={feather} disabled={readonly} onChange={(event) => setFeather(clampMaskFeather(Number(event.currentTarget.value) || 0))} /></label>
      <Button size="sm" disabled={readonly} onClick={apply}>应用属性</Button>
      <div className="photo-editor__advanced-row">
        <Button size="sm" tone={properties.view === "gray" ? "neutral" : "ghost"} disabled={readonly} onClick={() => view("gray")}>独立查看</Button>
        <Button size="sm" tone={properties.view === "overlay" ? "neutral" : "ghost"} disabled={readonly} onClick={() => view("overlay")}>叠加查看</Button>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={toggleOverlay}>切换叠加（\）</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !properties.view} onClick={() => view("off")}>关闭查看</Button>
      </div>
      <span className="photo-editor__option-hint">密度与羽化属于内容；查看只改会话</span>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}
