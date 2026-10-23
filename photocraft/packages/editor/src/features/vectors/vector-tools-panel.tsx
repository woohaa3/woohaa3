import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { isRecord } from "../shared/panels.js";
import { SHAPE_KINDS, SHAPE_LABELS, hitTolerance, shapeCreateParams, type ShapeKind } from "./shape-tools.js";
import { BOOLEAN_LABELS, BOOLEAN_NOTES, BOOLEAN_OPS, booleanAvailability, booleanCommand, booleanParams, PATH_MATRIX, clippingPathParams, pathToSelectionParams, selectionToShapeParams, transformParams, type BooleanOp } from "./boolean-ops.js";
import { MASK_ACTIONS, maskEditParams, maskFromPathParams, maskState, maskSummaryText, maskVisibilityParams, rasterizeMaskParams, type VectorMaskSummary } from "./mask-edit.js";
import { decodeLibrary, defineCustomShapeParams, libraryEntries, newPresetParams, placePresetParams, presetEditParams, type ShapePresetLibrary } from "./presets.js";
import { presetChoice, setPresetChoice } from "./preset-selection.js";
import { pathChoice, setPathChoice, subscribePathChoice } from "./path-selection.js";
import { setShapeToolOptions, shapeSizeRequest, subscribeShapeSizeRequest } from "./shape-options.js";

/** 快照里的形状摘要（`vectorSnapshot()` 的 `shapes[]`）。 */
type ShapeSummary = {
  layer: number;
  name?: string;
  kind?: string;
  live?: Record<string, unknown> | null;
  hasFill?: boolean;
  hasStroke?: boolean;
  fill?: { type?: string; hex?: string; name?: string };
  stroke?: { width?: number; opacity?: number; align?: string; cap?: string; join?: string; miterLimit?: number; dashes?: number[]; dashOffset?: number; paint?: { hex?: string } };
};

type VectorSnapshot = {
  shapes?: ShapeSummary[];
  vectorMasks?: (VectorMaskSummary & { density: number; feather: number })[];
  paths?: { name: string }[];
  workPath?: unknown;
  clippingPath?: { name?: string; flatness?: number } | null;
};

/** 形状草稿：面板里的所有几何/填充/描边都先改这份草稿，确认后才提交一步历史。 */
type ShapeDraft = {
  kind: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  sides: number;
  starRatio: number;
  weight: number;
  fill: string;
  fills: boolean;
  strokes: boolean;
  strokeWidth: number;
  strokeColor: string;
  opacity: number;
  align: "inside" | "center" | "outside";
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  dashes: string;
  dashOffset: number;
  fillRule: "nonzero" | "evenodd";
};

const DEFAULT_DRAFT: ShapeDraft = {
  kind: "rect", x: 0, y: 0, width: 100, height: 100, radius: 0, sides: 5, starRatio: 0.5, weight: 2,
  fill: "#3366cc", fills: true, strokes: false, strokeWidth: 3, strokeColor: "#000000", opacity: 1,
  align: "center", cap: "butt", join: "miter", dashes: "", dashOffset: 0, fillRule: "nonzero",
};

function draftFromShape(shape: ShapeSummary): ShapeDraft {
  const live = shape.live ?? {};
  const rect = Array.isArray(live.rect) ? live.rect as number[] : [0, 0, 100, 100];
  const wireKind = (SHAPE_KINDS as readonly string[]).includes(shape.kind ?? "") ? shape.kind as ShapeKind : "rect";
  const liveSides = typeof live.sides === "number" ? live.sides : 5;
  const liveRatio = typeof live.star_ratio === "number" ? live.star_ratio : 0.5;
  // 三角形在 wire 上是 `polygon` + `sides: 3`（内核没有 triangle 种类）；回填时换回界面种类，
  // 否则刚画好的三角形会在属性面板里显示成「多边形 / 边数 3」。
  const kind: ShapeKind = wireKind === "polygon" && liveSides === 3 && liveRatio >= 1 ? "triangle" : wireKind;
  const radii = Array.isArray(live.radii) ? Number(live.radii[0]) : 0;
  return {
    ...DEFAULT_DRAFT,
    kind,
    x: Number(rect[0] ?? 0), y: Number(rect[1] ?? 0), width: Number(rect[2] ?? 100), height: Number(rect[3] ?? 100),
    radius: radii,
    sides: liveSides,
    starRatio: liveRatio,
    weight: typeof live.weight === "number" ? live.weight : 2,
    fill: shape.fill?.hex ?? DEFAULT_DRAFT.fill,
    fills: shape.hasFill !== false,
    strokes: shape.hasStroke === true,
    strokeWidth: shape.stroke?.width ?? 3,
    strokeColor: shape.stroke?.paint?.hex ?? "#000000",
    opacity: shape.stroke?.opacity ?? 1,
    align: (shape.stroke?.align as ShapeDraft["align"]) ?? "center",
    cap: (shape.stroke?.cap as ShapeDraft["cap"]) ?? "butt",
    join: (shape.stroke?.join as ShapeDraft["join"]) ?? "miter",
    dashes: (shape.stroke?.dashes ?? []).join(" "),
    dashOffset: shape.stroke?.dashOffset ?? 0,
  };
}

/** 描边参数（与上游 `shape.create` / `shape.edit` 的 stroke 同形）。 */
function strokeParams(draft: ShapeDraft) {
  if (!draft.strokes) return null;
  return {
    width: draft.strokeWidth,
    color: draft.strokeColor,
    opacity: draft.opacity,
    align: draft.align,
    cap: draft.cap,
    join: draft.join,
    dashes: draft.dashes.split(/[\s,]+/).filter(Boolean).map(Number).filter(value => Number.isFinite(value) && value >= 0),
    dashOffset: draft.dashOffset,
  };
}

/** 形状几何参数：数值创建与图内拖绘共用 `shapeCreateParams`。 */
function geometryParams(draft: ShapeDraft): Record<string, unknown> {
  if (draft.kind === "line") {
    return shapeCreateParams({
      kind: "line",
      start: [draft.x, draft.y],
      end: [draft.x + draft.width, draft.y + draft.height],
      weight: draft.weight,
    });
  }
  const params = shapeCreateParams({
    kind: draft.kind,
    start: [draft.x, draft.y],
    end: [draft.x + draft.width, draft.y + draft.height],
    radius: draft.radius,
    sides: draft.sides,
    starRatio: draft.starRatio,
  });
  delete params.rect;
  return { ...params, rect: [draft.x, draft.y, draft.width, draft.height], fillRule: draft.fillRule };
}

export function VectorToolsPanel({ controller, readonly, layer, color, hasSelection, revision, shapeLayers }: {
  controller: EditorWorkspaceController; readonly: boolean; layer: number | null; color: string; hasSelection: boolean; revision: number;
  /** 选中的形状图层数量（布尔运算的整层合并前置条件）。 */
  shapeLayers: number;
}) {
  const [draft, setDraft] = useState<ShapeDraft>({ ...DEFAULT_DRAFT, fill: color });
  const [editing, setEditing] = useState<ShapeDraft | null>(null);
  // 路径目标是**跨面板共享的工具状态**：面板选了什么，画布上的钢笔落点与锚点编辑就改什么。
  const pathName = useSyncExternalStore(
    useCallback(listener => subscribePathChoice(listener), []),
    useCallback(() => pathChoice(), []),
  );
  const setPathName = setPathChoice;
  const [newName, setNewName] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetGroup, setPresetGroup] = useState("");
  const [presetValue, setPresetValue] = useState(() => {
    const current = presetChoice();
    return current ? `${current.group}\u0000${current.name}` : "";
  });
  /** 选中项（`presetValue` 是 `group\0name`，自定形状的组名是合成的）。 */
  const [chosen, setChosen] = useState<{ group: string; name: string; custom: boolean } | null>(presetChoice);
  const [presetRename, setPresetRename] = useState("");
  const [presetMoveTo, setPresetMoveTo] = useState("");
  /** 组管理选择（重命名/删除分组用）。 */
  const [manageGroup, setManageGroup] = useState("");
  const [tolerance, setTolerance] = useState(2);
  const [message, setMessage] = useState<string | null>(null);
  // 「单击画布 → 尺寸输入」（design D1）：画布把点击位置交给这里，面板填入起点并聚焦宽度。
  const sizeRequest = useSyncExternalStore(
    useCallback(listener => subscribeShapeSizeRequest(listener), []),
    useCallback(() => shapeSizeRequest(), []),
  );
  const sectionRef = useRef<HTMLElement | null>(null);
  const createdSize = useRef(sizeRequest.id);
  useEffect(() => {
    if (sizeRequest.id === createdSize.current) return;
    createdSize.current = sizeRequest.id;
    setDraft(current => ({ ...current, x: Math.round(sizeRequest.point[0]), y: Math.round(sizeRequest.point[1]) }));
    // 面板可能处于收起状态：先滚动到可见，再聚焦宽度输入，用户直接键入尺寸即可回车创建。
    const section = sectionRef.current;
    const width = section?.querySelector<HTMLInputElement>("[data-shape-width]");
    section?.scrollIntoView?.({ block: "nearest" });
    width?.focus();
    setMessage("单击不会创建零面积形状：已填入起点，请输入宽高后点「创建形状」");
  }, [sizeRequest]);

  // 面板里改的几何/描边要同时作用于**图内拖绘**（U08/U09）：两边共用同一个参数 store，
  // 否则会出现「面板显示圆角 10、拖出来却是直角」这种只有接线后才暴露的错位。
  useEffect(() => {
    setShapeToolOptions({
      radius: draft.radius,
      sides: draft.sides,
      starRatio: draft.starRatio,
      weight: draft.weight,
      stroke: strokeParams(draft),
    });
  }, [draft.radius, draft.sides, draft.starRatio, draft.weight, draft.fills, draft.strokes, draft.strokeWidth, draft.strokeColor, draft.opacity, draft.align, draft.cap, draft.join, draft.dashes, draft.dashOffset]);

  const snapshot = controller.vectorSnapshot?.();
  const data: VectorSnapshot = snapshot?.ok && isRecord(snapshot.value) ? snapshot.value as VectorSnapshot : {};
  // 预设库是**工具状态**（不进文档修订），走本域会话直读，不新增共享控制器方法。
  const libraryResult = controller.features.vectors.vectorPresets();
  const decoded = libraryResult.ok ? decodeLibrary(libraryResult.value) : null;
  const library: ShapePresetLibrary | null = decoded;
  const presets = useMemo(() => library ? libraryEntries(library) : [], [library]);
  /** 真实分组名（不含「自定形状」合成组），供分组管理下拉与计数使用。 */
  const groupNames = useMemo(() => library ? library.groups.map(group => group.name) : [], [library]);
  const shapes = data.shapes ?? [];
  const selected = shapes.find(shape => shape.layer === layer);
  const mask = data.vectorMasks?.find(entry => entry.layer === layer);
  const maskStatus = maskState(mask);

  const run = (id: string, params: Record<string, unknown>) => {
    const result = controller.vectorCommand(id, params);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };
  const attempt = (action: () => void) => {
    try { action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const update = <K extends keyof ShapeDraft>(key: K, value: ShapeDraft[K]) =>
    setEditing(current => current ? { ...current, [key]: value } : current);

  const createShape = () => attempt(() => {
    const params = geometryParams(draft);
    const stroke = strokeParams(draft);
    run("shape.create", {
      ...params,
      ...(draft.fills ? { fill: draft.fill } : { fill: null }),
      ...(stroke ? { stroke } : {}),
    });
  });

  const beginEdit = () => {
    if (!selected) return;
    setEditing(draftFromShape(selected));
    setMessage(null);
  };

  const applyEdit = () => attempt(() => {
    if (!editing || layer == null) return;
    const params = geometryParams(editing);
    const stroke = strokeParams(editing);
    const ok = run("shape.edit", {
      layer,
      ...params,
      fill: editing.fills ? editing.fill : null,
      stroke,
    });
    if (ok) setEditing(null);
  });

  const booleanState = { shapeLayers, activeIsShape: !!selected, readonly };

  return <section ref={sectionRef} className="photo-editor__advanced-group" data-vector-tools={revision}>
    <span className="photo-editor__options-title">形状与路径</span>

    {/* ---------------------------------------------------------------- 形状 */}
    <label>形状<select value={draft.kind} disabled={readonly} onChange={event => setDraft(current => ({ ...current, kind: event.currentTarget.value as ShapeKind }))}>
      {SHAPE_KINDS.map(kind => <option key={kind} value={kind}>{SHAPE_LABELS[kind]}</option>)}
    </select></label>
    <p className="photo-editor__brush-note">图内拖动可直接绘制（Shift 约束比例/角度，Alt 从中心）；按 Esc 取消。零面积不会创建形状。</p>
    {([["x", "X"], ["y", "Y"], ["width", "宽"], ["height", "高"]] as const).map(([key, label]) =>
      <label key={key}>{label}<input type="number" value={draft[key]} min={key === "width" || key === "height" ? 1 : undefined} disabled={readonly}
        {...(key === "width" ? { "data-shape-width": true } : {})}
        onChange={event => setDraft(current => ({ ...current, [key]: Number(event.currentTarget.value) }))} /></label>)}
    {(draft.kind === "rect" || draft.kind === "roundedRect") ?
      <label>圆角<input type="number" min={0} value={draft.radius} disabled={readonly} onChange={event => setDraft(current => ({ ...current, radius: Number(event.currentTarget.value) }))} /></label> : null}
    {draft.kind === "polygon" || draft.kind === "star" ?
      <label>边数<input type="number" min={3} max={100} value={draft.sides} disabled={readonly} onChange={event => setDraft(current => ({ ...current, sides: Number(event.currentTarget.value) }))} /></label> : null}
    {draft.kind === "star" ?
      <label>内外比例<input type="number" min={0.01} max={0.99} step={0.01} value={draft.starRatio} disabled={readonly} onChange={event => setDraft(current => ({ ...current, starRatio: Number(event.currentTarget.value) }))} /></label> : null}
    {draft.kind === "line" ?
      <label>线宽<input type="number" min={0} value={draft.weight} disabled={readonly} onChange={event => setDraft(current => ({ ...current, weight: Number(event.currentTarget.value) }))} /></label> : null}
    <label><input type="checkbox" checked={draft.fills} disabled={readonly} onChange={event => setDraft(current => ({ ...current, fills: event.currentTarget.checked }))} />填充</label>
    {draft.fills ? <label>填充色<input type="color" value={draft.fill} disabled={readonly} onChange={event => setDraft(current => ({ ...current, fill: event.currentTarget.value }))} /></label> : null}
    <label>填充规则<select value={draft.fillRule} disabled={readonly} onChange={event => setDraft(current => ({ ...current, fillRule: event.currentTarget.value as ShapeDraft["fillRule"] }))}><option value="nonzero">非零</option><option value="evenodd">奇偶</option></select></label>
    <label><input type="checkbox" checked={draft.strokes} disabled={readonly} onChange={event => setDraft(current => ({ ...current, strokes: event.currentTarget.checked }))} />描边</label>
    {draft.strokes ? <>
      <label>描边宽度<input type="number" min={0} max={1000000} value={draft.strokeWidth} disabled={readonly} onChange={event => setDraft(current => ({ ...current, strokeWidth: Number(event.currentTarget.value) }))} /></label>
      <label>描边色<input type="color" value={draft.strokeColor} disabled={readonly} onChange={event => setDraft(current => ({ ...current, strokeColor: event.currentTarget.value }))} /></label>
      <label>对齐<select value={draft.align} disabled={readonly} onChange={event => setDraft(current => ({ ...current, align: event.currentTarget.value as ShapeDraft["align"] }))}><option value="inside">内部</option><option value="center">居中</option><option value="outside">外部</option></select></label>
      <label>线帽<select value={draft.cap} disabled={readonly} onChange={event => setDraft(current => ({ ...current, cap: event.currentTarget.value as ShapeDraft["cap"] }))}><option value="butt">平头</option><option value="round">圆头</option><option value="square">方头</option></select></label>
      <label>拐角<select value={draft.join} disabled={readonly} onChange={event => setDraft(current => ({ ...current, join: event.currentTarget.value as ShapeDraft["join"] }))}><option value="miter">尖角</option><option value="round">圆角</option><option value="bevel">斜角</option></select></label>
      <label>虚线<input value={draft.dashes} placeholder="例如 4 2（以描边宽度为倍数）" disabled={readonly} onChange={event => setDraft(current => ({ ...current, dashes: event.currentTarget.value }))} /></label>
      <label>虚线偏移<input type="number" value={draft.dashOffset} disabled={readonly} onChange={event => setDraft(current => ({ ...current, dashOffset: Number(event.currentTarget.value) }))} /></label>
    </> : null}
    <Button size="sm" disabled={readonly} onClick={createShape}>创建形状</Button>

    {/* ------------------------------------------------------ 选中形状属性 (U10) */}
    {selected ? <div className="photo-editor__advanced-subgroup" data-shape-properties={selected.layer}>
      <span className="photo-editor__options-title">当前形状 · {selected.name ?? selected.layer}</span>
      <p className="photo-editor__brush-note">{`规范形状：${SHAPE_LABELS[draftFromShape(selected).kind] ?? selected.kind ?? "路径"}`}{selected.hasFill ? " · 有填充" : " · 无填充"}{selected.hasStroke ? " · 有描边" : " · 无描边"}</p>
      {editing ? <>
        {/* 尺寸与创建草稿同形，提交时仍是一条 `shape.edit`（不新增形状）。 */}
        {([["x", "X"], ["y", "Y"], ["width", "宽"], ["height", "高"]] as const).map(([key, label]) =>
          <label key={key}>{label}<input type="number" value={editing[key]} min={key === "width" || key === "height" ? 1 : undefined} disabled={readonly}
            onChange={event => update(key, Number(event.currentTarget.value))} /></label>)}
        {(editing.kind === "rect" || editing.kind === "roundedRect") ?
          <label>圆角<input type="number" min={0} value={editing.radius} disabled={readonly} onChange={event => update("radius", Number(event.currentTarget.value))} /></label> : null}
        {editing.kind === "polygon" || editing.kind === "star" ?
          <label>边数<input type="number" min={3} max={100} value={editing.sides} disabled={readonly} onChange={event => update("sides", Number(event.currentTarget.value))} /></label> : null}
        {editing.kind === "star" ?
          <label>内外比例<input type="number" min={0.01} max={0.99} step={0.01} value={editing.starRatio} disabled={readonly} onChange={event => update("starRatio", Number(event.currentTarget.value))} /></label> : null}
        <label><input type="checkbox" checked={editing.fills} disabled={readonly} onChange={event => update("fills", event.currentTarget.checked)} />填充</label>
        {editing.fills ? <label>填充色<input type="color" value={editing.fill} disabled={readonly} onChange={event => update("fill", event.currentTarget.value)} /></label> : null}
        <label><input type="checkbox" checked={editing.strokes} disabled={readonly} onChange={event => update("strokes", event.currentTarget.checked)} />描边</label>
        {editing.strokes ? <>
          <label>描边宽度<input type="number" min={0} max={1000000} value={editing.strokeWidth} disabled={readonly} onChange={event => update("strokeWidth", Number(event.currentTarget.value))} /></label>
          <label>描边色<input type="color" value={editing.strokeColor} disabled={readonly} onChange={event => update("strokeColor", event.currentTarget.value)} /></label>
          <label>对齐<select value={editing.align} disabled={readonly} onChange={event => update("align", event.currentTarget.value as ShapeDraft["align"])}><option value="inside">内部</option><option value="center">居中</option><option value="outside">外部</option></select></label>
          <label>线帽<select value={editing.cap} disabled={readonly} onChange={event => update("cap", event.currentTarget.value as ShapeDraft["cap"])}><option value="butt">平头</option><option value="round">圆头</option><option value="square">方头</option></select></label>
          <label>拐角<select value={editing.join} disabled={readonly} onChange={event => update("join", event.currentTarget.value as ShapeDraft["join"])}><option value="miter">尖角</option><option value="round">圆角</option><option value="bevel">斜角</option></select></label>
          <label>虚线<input value={editing.dashes} disabled={readonly} onChange={event => update("dashes", event.currentTarget.value)} /></label>
        </> : null}
        <Button size="sm" disabled={readonly} onClick={applyEdit}>应用属性</Button>
        <Button size="sm" tone="ghost" onClick={() => setEditing(null)}>取消</Button>
      </> : <Button size="sm" disabled={readonly} onClick={beginEdit}>编辑形状属性</Button>}
      <Button size="sm" disabled={readonly} onClick={() => run("shape.rasterize", { layer: selected.layer })}>栅格化形状</Button>
    </div> : null}

    {/* --------------------------------------------------------- 布尔运算 (U14) */}
    <span className="photo-editor__options-title">布尔运算</span>
    {BOOLEAN_OPS.map(op => {
      const availability = booleanAvailability(op as BooleanOp, booleanState);
      return <Button key={op} size="sm" disabled={readonly || !availability.enabled}
        title={availability.enabled ? BOOLEAN_NOTES[op as BooleanOp] : availability.reason}
        onClick={() => attempt(() => run(booleanCommand(op as BooleanOp), booleanParams(op as BooleanOp, { tolerance: op === "mergeShapeComponents" ? 0.1 : undefined })))}>
        {BOOLEAN_LABELS[op as BooleanOp]}
      </Button>;
    })}
    {!booleanState.activeIsShape ? <p className="photo-editor__brush-note">先在图层列表选中形状图层；两个以上形状层可整体合并。</p> : null}

    {/* ------------------------------------------------------------ 路径 (U11–U13) */}
    <span className="photo-editor__options-title">路径</span>
    <label>路径<select value={pathName} disabled={readonly} onChange={event => setPathName(event.currentTarget.value)}>
      <option value="work">工作路径</option><option value="layer">当前图层路径</option>
      {data.paths?.map(path => <option key={path.name} value={path.name}>{path.name}</option>)}
    </select></label>
    <Button size="sm" disabled={readonly || !hasSelection} onClick={() => run("select.toWorkPath", { tolerance: tolerance })}>选区转工作路径</Button>
    <Button size="sm" disabled={readonly} onClick={() => attempt(() => run("path.toSelection", pathToSelectionParams({ name: pathName }, { feather: 0, mode: "replace" })))}>路径转选区</Button>
    <label>简化容差<input type="number" min={0.5} max={10} step={0.5} value={tolerance} disabled={readonly} onChange={event => setTolerance(Number(event.currentTarget.value))} /></label>
    <label>保存名称<input value={newName} disabled={readonly} onChange={event => setNewName(event.currentTarget.value)} /></label>
    <Button size="sm" disabled={readonly || !newName.trim()} onClick={() => run("path.rename", { name: pathName, to: newName.trim() })}>保存 / 重命名路径</Button>
    <Button size="sm" disabled={readonly} onClick={() => run("path.fill", { name: pathName, color })}>填充路径</Button>
    <Button size="sm" disabled={readonly} onClick={() => run("path.stroke", { name: pathName, color, size: draft.strokeWidth })}>描边路径</Button>
    <Button size="sm" tone="ghost" disabled={readonly || pathName === "layer"} onClick={() => run("path.delete", { name: pathName })}>删除路径</Button>
    <div className="photo-editor__advanced-row" data-path-transform="true">
      <Button size="sm" disabled={readonly} onClick={() => attempt(() => run("path.transform", transformParams({ name: pathName }, PATH_MATRIX.translate(10, 0))))}>右移 10</Button>
      <Button size="sm" disabled={readonly} onClick={() => attempt(() => run("path.transform", transformParams({ name: pathName }, PATH_MATRIX.rotate(90))))}>旋转 90°</Button>
      <Button size="sm" disabled={readonly} onClick={() => attempt(() => run("path.transform", transformParams({ name: pathName }, PATH_MATRIX.scale(0.5))))}>缩小一半</Button>
    </div>
    <Button size="sm" disabled={readonly || pathName === "layer"} onClick={() => attempt(() => run("path.clippingPath.set", clippingPathParams(pathName, 0)))}>设为裁切路径</Button>
    <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("path.clippingPath.clear", {})}>清除裁切路径</Button>
    {data.clippingPath?.name ? <p className="photo-editor__brush-note">{`当前裁切路径：${data.clippingPath.name}`}</p> : null}
    <Button size="sm" disabled={readonly || !hasSelection} onClick={() => attempt(() => run("select.convertToShape", selectionToShapeParams({ tolerance, fill: color })))}>选区转形状</Button>

    {/* ------------------------------------------------------- 矢量蒙版 (U15) */}
    <span className="photo-editor__options-title">矢量蒙版</span>
    <Button size="sm" disabled={readonly || layer === null} onClick={() => run(MASK_ACTIONS.fromPath, maskFromPathParams(layer, pathName))}>路径设为矢量蒙版</Button>
    {/* `layer.vectorMask.currentPath` 与 `fromPath` 在上游是**同一个实现**（`vector_mask_add(.., true)`），
        行为完全一致，因此面板只给一个按钮，不摆两个同义入口。 */}
    <Button size="sm" disabled={readonly || layer === null} onClick={() => run(MASK_ACTIONS.revealAll, maskVisibilityParams(layer, true))}>全显</Button>
    <Button size="sm" disabled={readonly || layer === null} onClick={() => run(MASK_ACTIONS.hideAll, maskVisibilityParams(layer, false))}>全隐</Button>
    {mask ? <>
      <p className="photo-editor__brush-note">{maskSummaryText(mask)}</p>
      <label><input type="checkbox" checked={mask.enabled} disabled={readonly} onChange={event => run(MASK_ACTIONS.enabled, { layer, enabled: event.currentTarget.checked })} />启用矢量蒙版</label>
      <label><input type="checkbox" checked={mask.linked} disabled={readonly} onChange={event => run(MASK_ACTIONS.linked, { layer, linked: event.currentTarget.checked })} />链接矢量蒙版</label>
      <label>密度<input type="number" min={0} max={100} value={Math.round(mask.density * 100)} disabled={readonly}
        onChange={event => attempt(() => run(MASK_ACTIONS.edit, maskEditParams(layer!, { density: Number(event.currentTarget.value) })))} /></label>
      <label>羽化<input type="number" min={0} max={1000} value={mask.feather} disabled={readonly}
        onChange={event => attempt(() => run(MASK_ACTIONS.edit, maskEditParams(layer!, { feather: Number(event.currentTarget.value) })))} /></label>
      <Button size="sm" disabled={readonly} onClick={() => attempt(() => run(MASK_ACTIONS.edit, maskEditParams(layer!, { invert: true })))}>反转蒙版</Button>
      <Button size="sm" disabled={readonly} onClick={() => run(MASK_ACTIONS.rasterize, rasterizeMaskParams(layer))}>栅格化矢量蒙版</Button>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run(MASK_ACTIONS.delete, { layer })}>删除矢量蒙版</Button>
      <p className="photo-editor__brush-note">{`状态：${maskStatus === "disabled" ? "已停用" : "可编辑"}；用直接选择工具拖动锚点会只改蒙版几何。`}</p>
    </> : null}
    <Button size="sm" disabled={readonly || layer === null} onClick={() => run("layer.rasterize.shape", { layer })}>栅格化形状层</Button>

    {/* ------------------------------------------------- 自定形状与预设 (U16) */}
    <span className="photo-editor__options-title">自定形状与预设</span>
    <label>预设<select value={presetValue} disabled={readonly} onChange={event => {
      const value = event.currentTarget.value;
      setPresetValue(value);
      const [group, name] = value.split("\u0000");
      // 组名从 `libraryEntries` 回查，只有它知道「自定形状」是合成组而不是真实分组。
      const hit = presets.find(entry => entry.entry.name === name && entry.group === group);
      const next = hit ? { group: hit.group, name: hit.entry.name, custom: hit.custom } : null;
      setChosen(next);
      // 画布上的 Custom Shape 拖绘读同一份选择：面板选了什么，拖出来就是什么。
      setPresetChoice(next);
    }}>
      <option value="">选择预设…</option>
      {presets.map(entry => <option key={`${entry.group}/${entry.entry.name}`} value={`${entry.group}\u0000${entry.entry.name}`}>{entry.group} · {entry.entry.name}</option>)}
    </select></label>
    <Button size="sm" disabled={readonly || !presetValue || layer === null} onClick={() => attempt(() => {
      const [group, name] = presetValue.split("\u0000");
      run("shape.presets.place", placePresetParams(name, [draft.x, draft.y, Math.max(1, draft.width), Math.max(1, draft.height)], { group, fill: color }));
    })}>放置预设</Button>

    <div className="photo-editor__advanced-subgroup" data-preset-library={library?.custom.length ?? 0}>
      <span className="photo-editor__options-title">库管理</span>
      <p className="photo-editor__brush-note">{chosen ? `已选：${chosen.group} · ${chosen.name}${chosen.custom ? "（自定形状）" : ""}` : "先在上方选择一个预设，再重命名/移动/删除。"}</p>
      <label>重命名为<input value={presetRename} placeholder={chosen?.name ?? "新名称"} disabled={readonly || !chosen} onChange={event => setPresetRename(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={readonly || !chosen || !presetRename.trim()} onClick={() => attempt(() => {
        // 上游按 `group` 收窄查找：真实分组里的预设带组名，自定形状不带（它们不在 `presets.shapes` 里）。
        run("shape.presets.edit", presetEditParams({ action: "rename", preset: chosen!.name, name: presetRename.trim(), ...(chosen!.custom ? {} : { group: chosen!.group }) }));
        setPresetValue(""); setChosen(null); setPresetChoice(null); setPresetRename("");
      })}>重命名所选预设</Button>
      <label>移动到<input value={presetMoveTo} placeholder="目标分组名（不存在则新建）" disabled={readonly || !chosen || chosen.custom} onChange={event => setPresetMoveTo(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={readonly || !chosen || chosen.custom || !presetMoveTo.trim()}
        title={chosen?.custom ? "自定形状由「从当前路径定义形状」管理，上游不支持在组间移动" : "把所选预设移入目标分组"}
        onClick={() => attempt(() => {
          run("shape.presets.edit", presetEditParams({ action: "move", preset: chosen!.name, group: chosen!.group, to: presetMoveTo.trim() }));
          setPresetValue(""); setChosen(null); setPresetChoice(null); setPresetMoveTo("");
        })}>移动到分组</Button>
      <Button size="sm" tone="ghost" disabled={readonly || !chosen} onClick={() => attempt(() => {
        run("shape.presets.edit", presetEditParams({ action: "delete", preset: chosen!.name, ...(chosen!.custom ? {} : { group: chosen!.group }) }));
        setPresetValue(""); setChosen(null); setPresetChoice(null);
      })}>删除所选预设</Button>
    </div>

    <div className="photo-editor__advanced-subgroup" data-preset-groups={groupNames.length}>
      <span className="photo-editor__options-title">分组</span>
      <label>管理分组<select value={manageGroup} disabled={readonly} onChange={event => setManageGroup(event.currentTarget.value)}>
        <option value="">（未选择）</option>
        {groupNames.map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>
      <label>分组名称<input value={presetGroup} placeholder="新名称 / 保存预设时的分组" disabled={readonly} onChange={event => setPresetGroup(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={readonly || !presetGroup.trim()} onClick={() => attempt(() => run("shape.presets.edit", presetEditParams({ action: "newGroup", name: presetGroup.trim() })))}>新建分组</Button>
      <Button size="sm" disabled={readonly || !manageGroup || !presetGroup.trim()} onClick={() => attempt(() => {
        run("shape.presets.edit", presetEditParams({ action: "renameGroup", group: manageGroup, name: presetGroup.trim() }));
        setManageGroup(""); setPresetGroup("");
      })}>重命名分组</Button>
      <Button size="sm" tone="ghost" disabled={readonly || !manageGroup} onClick={() => attempt(() => {
        run("shape.presets.edit", presetEditParams({ action: "deleteGroup", group: manageGroup }));
        setManageGroup("");
      })}>删除分组</Button>
      <p className="photo-editor__brush-note">{`共 ${groupNames.length} 个分组；删除分组不会改变已应用的形状。`}</p>
    </div>

    <label>形状名称<input value={presetName} disabled={readonly} onChange={event => setPresetName(event.currentTarget.value)} /></label>
    <Button size="sm" disabled={readonly || !presetName.trim()} onClick={() => attempt(() => run("edit.defineCustomShape", defineCustomShapeParams(presetName, pathName === "layer" ? undefined : pathName)))}>从当前路径定义形状</Button>
    <Button size="sm" disabled={readonly || !presetName.trim()} onClick={() => attempt(() => run("shape.presets.new", newPresetParams(presetName, { group: presetGroup || undefined, path: pathName === "layer" ? undefined : pathName })))}>保存为预设</Button>
    <Button size="sm" tone="ghost" disabled={readonly} onClick={() => run("shape.presets.reset", {})}>恢复默认形状</Button>
    <p className="photo-editor__brush-note">{`库内自定形状：${library?.custom.length ?? 0} 个。`}</p>

    {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
  </section>;
}

/** 当前取景下的源像素命中容差（界面提示与直接选择共用）。 */
export function selectionTolerance(zoom: number, screenPx = 6): number {
  return hitTolerance(screenPx, zoom);
}
