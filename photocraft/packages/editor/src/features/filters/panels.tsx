import { useEffect, useMemo, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { supports } from "../shared/panels.js";
import {
  FILTER_CURVE_CHANNELS,
  FILTER_GRADE_WHEELS,
  FILTER_HSL_BAND_NAMES,
  FILTER_LIMITS,
  FILTER_LIGHT_KINDS,
  addClone,
  addPaste,
  addConstraint,
  addCurvePoint,
  addEffect,
  addShearPoint,
  addLight,
  addPin,
  addPlane,
  FILTER_KERNEL_SIZE,
  blurPaths,
  blurPinKey,
  blurPins,
  filterKernel,
  identityKernel,
  lensStraighten,
  newStraighten,
  catalogueCategories,
  coerceParam,
  currentValue,
  curveSplits,
  declaresParam,
  defaultParams,
  filterCurve,
  filterHsl,
  filterLights,
  flamePath,
  filterWheel,
  identityCurve,
  moveCurvePoint,
  moveEffect,
  moveShearPoint,
  mapLayerOf,
  shearPoints,
  defaultShearPoints,
  moveLight,
  newEffect,
  newLight,
  newPaste,
  paramStep,
  removeClone,
  removeConstraint,
  removeCurvePoint,
  removeEffect,
  removeShearPoint,
  removeLight,
  removePaste,
  removePin,
  removePlane,
  replaceEffect,
  setEffectParam,
  setPlaneCorner,
  setCloneBrush,
  setCloneGeometry,
  setPaste,
  stackEffects,
  stackParams,
  toggleEffect,
  vanishingClones,
  vanishingPastes,
  vanishingPlanes,
  wideAngleConstraints,
  withBlurPaths,
  withBlurPins,
  withCurve,
  withCurveSplits,
  withHslBand,
  withKernel,
  withFlamePath,
  withLights,
  withStraighten,
  withClones,
  withConstraints,
  withPastes,
  withMapDocument,
  withMapLayer,
  withPlanes,
  withShearPoints,
  withWheel,
  type FilterBlurPath,
  type FilterCatalogue,
  type FilterCloneStroke,
  type FilterConstraint,
  type FilterDocumentSize,
  type FilterCurveChannel,
  type FilterCurvePoint,
  type FilterEntry,
  type FilterLayerSource,
  type FilterLight,
  type FilterMapSource,
  type FilterPaste,
  type FilterParamSpec,
  type FilterPathSources,
  type FilterPin,
  type FilterPlane,
  type FilterStackEffect,
  type FilterShearPoint,
  type FilterStraighten
} from "./catalogue.js";

/**
 * 参数滤镜面板（U46–U49）。
 *
 * 面板本身不持有文档：它只维护「正在编辑的输入」，把每次有效输入交给
 * `controller.features.filters` 的草稿通道，由内核渲染候选图。确认/取消沿用共享草稿门禁，
 * 因此保存、切文档、关闭都会被同一处拦住。
 *
 * 滤镜与参数范围**全部由内核清单驱动**：`filterCatalogue()` 给出分类、命令、交互形态与参数
 * schema；这里没有第二份硬编码范围。清单不可用时不渲染面板（design D11）。
 */

/**
 * 面板顶部的常用入口；点一下即按内核默认参数开始草稿。
 *
 * `min`/`max` 只用于声明这两个入口的快捷值范围，权威范围仍来自内核清单
 * （`catalogue` 里同一条命令的 schema）。
 */
export const FILTER_TOOLS = [
  { id: "filter.blur.gaussianBlur", label: "高斯模糊", key: "radius", min: 0.1, max: 1000, step: 0.1, value: 2 },
  { id: "filter.sharpen.unsharpMask", label: "USM 锐化", key: "amount", min: 1, max: 500, step: 1, value: 80 }
] as const;

type Geometry = {
  pins: FilterPin[];
  paths: FilterBlurPath[];
  planes: FilterPlane[];
  constraints: FilterConstraint[];
  straighten: FilterStraighten | null;
  effects: FilterStackEffect[];
};

const emptyGeometry = (): Geometry => ({ pins: [], paths: [], planes: [], constraints: [], straighten: null, effects: [] });

/**
 * 文档尺寸：图内几何（透视平面、广角约束线）用文档像素，0–1 相对值会被内核判成退化。
 *
 * 宿主替身没有 `currentView`（面板测试、旧句柄）时退化为 1×1：平面仍可添加，只是角点范围
 * 等于单位方格，不会悄悄换成别的单位。
 */
function documentSizeOf(controller: EditorWorkspaceController): FilterDocumentSize {
  const view = typeof controller.currentView === "function" ? controller.currentView() : null;
  const width = view?.document?.width;
  const height = view?.document?.height;
  return {
    width: Number.isFinite(width) && (width as number) > 0 ? (width as number) : 1,
    height: Number.isFinite(height) && (height as number) > 0 ? (height as number) : 1
  };
}

/** 从规范参数还原面板几何（草稿回执与「重复上次」都走这里）。 */
function geometryOf(entry: FilterEntry | undefined, params: Record<string, unknown>): Geometry {
  if (!entry) return emptyGeometry();
  const blur = entry.kind === "blurGallery";
  return {
    // 只有真的声明了 `pins` 的命令才画控制点：移轴模糊没有该字段，路径模糊用的是 `paths`。
    pins: blur && declaresParam(entry, "pins") ? blurPins(params, FILTER_LIMITS.maxPins, entry) : [],
    paths: blur && declaresParam(entry, "paths") ? blurPaths(params, FILTER_LIMITS.maxPins) : [],
    planes: entry.kind === "vanishingPoint" ? vanishingPlanes(params, FILTER_LIMITS.maxPlanes) : [],
    constraints: entry.id === "filter.adaptiveWideAngle" ? wideAngleConstraints(params, FILTER_LIMITS.maxResourcePoints) : [],
    // 镜头校正的拉直线是它唯一的图内几何（两点定一个角度）。
    straighten: declaresParam(entry, "straighten") ? lensStraighten(params) : null,
    effects: entry.kind === "galleryStack" ? stackEffects(params) : []
  };
}

/**
 * 面板上的标量参数（`seed` 与结构型字段由内核冻结/几何编辑器负责）。
 *
 * 声明了 `paths` 的命令，起止点与速度/锥度都有两层读法：`paths` 存在时内核只看 `paths`，
 * 那几个标量只是没有 `paths` 时的兜底。两条控制同时画出来，改标量会静默无效——所以这些
 * 兜底字段交给路径编辑器，不再重复出现在标量列表里。
 */
const scalarParams = (entry: FilterEntry): FilterParamSpec[] => {
  const pathOwned = declaresParam(entry, "paths") ? new Set(["startX", "startY", "endX", "endY", "speed", "taper"]) : null;
  return entry.params.filter((spec) =>
    spec.key !== "seed" && spec.kind !== "resource" && !(pathOwned?.has(spec.key) ?? false)
  );
};

export function FilterPanel({ controller, readonly, onChanged, initialFilter }: {
  initialFilter?: string;
  controller: EditorWorkspaceController;
  readonly: boolean;
  onChanged?: () => void;
}) {
  const features = controller.features.filters;
  const [catalogue, setCatalogue] = useState<FilterCatalogue | null>(null);
  const [filterId, setFilterId] = useState<string>(initialFilter ?? FILTER_TOOLS[0].id);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [geometry, setGeometry] = useState<Geometry>(emptyGeometry);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultStack, setDefaultStack] = useState<FilterStackEffect[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [mapSources, setMapSources] = useState<FilterMapSource[] | null>(null);
  // 消失点粘贴的图层来源：只在选中消失点且声明了 `paste` 时读一次。
  const [layerSources, setLayerSources] = useState<FilterLayerSource[] | null>(null);
  // 火焰的路径来源同样按需读：声明了 `path` 才去问内核有哪些已保存路径。
  const [pathSources, setPathSources] = useState<FilterPathSources | null>(null);
  // 每次渲染重读：文档尺寸会随打开/裁剪变化，角点夹取必须用当前画布。
  const documentSize = documentSizeOf(controller);

  const available = supports(controller, "beginFilter", "updateFilter", "commitFilter", "cancelFilter")
    && typeof features.filterCatalogue === "function";

  useEffect(() => {
    if (!available) return;
    const result = features.filterCatalogue();
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setCatalogue(result.value);
    const lastFilter = features.filterLast();
    setLast(lastFilter.ok && lastFilter.value.available ? lastFilter.value.label : null);
    // 滤镜库首次打开就要有可预览的候选：默认组合取内核给出的一份。
    const stack = features.filterGalleryDefaultStack();
    setDefaultStack(stack.ok ? stack.value : null);
    // 面板重挂载（切标签、折叠）时内核可能仍有草稿：回读它，不要把参数面板重置成默认值
    // 而让「确认」提交一份用户没见过的输入。
    const draft = features.filterDraftState();
    if (draft.ok && draft.value) {
      const entry = result.value.filters.find((candidate) => candidate.id === draft.value!.filter);
      if (entry) {
        setFilterId(entry.id);
        setParams(draft.value.params);
        setGeometry(geometryOf(entry, draft.value.params));
        setActive(true);
      }
    }
  }, [available, features]);

  const entry = useMemo(
    () => catalogue?.filters.find((candidate) => candidate.id === filterId) ?? catalogue?.filters[0],
    [catalogue, filterId]
  );

  // 位移图来源只在当前滤镜需要时读：读不到就保持 `null`，不画半套选择器。
  // 依赖里带上画布尺寸，切文档时重读；用户另开文档后可点选择器里的「刷新」再读一次。
  const needsMap = entry?.needsMap === true;
  const readMapSources = () => {
    if (typeof features.filterMapSources !== "function") {
      setMapSources(null);
      return;
    }
    const result = features.filterMapSources();
    if (!result.ok) {
      setMessage(result.message);
      setMapSources(null);
      return;
    }
    setMapSources(result.value);
  };
  useEffect(() => {
    if (needsMap) readMapSources();
  }, [needsMap, filterId, active, documentSize.width, documentSize.height]);

  // 粘贴图层来源：与位移图一样只在需要时读；读不到就保持 `null`，面板据此提示而不是画空下拉。
  const needsPaste = entry?.kind === "vanishingPoint" && declaresParam(entry, "paste");
  const readLayerSources = () => {
    if (typeof features.filterLayerSources !== "function") {
      setLayerSources(null);
      return;
    }
    const result = features.filterLayerSources();
    if (!result.ok) {
      setMessage(result.message);
      setLayerSources(null);
      return;
    }
    setLayerSources(result.value);
  };
  useEffect(() => {
    if (needsPaste) readLayerSources();
  }, [needsPaste, filterId, active]);

  // 火焰路径：只在命令声明了 `path` 时读；读不到就说明原因，不画空下拉。
  const needsPath = entry !== undefined && declaresParam(entry, "path");
  const readPathSources = () => {
    if (typeof features.filterPathSources !== "function") {
      setPathSources(null);
      return;
    }
    const result = features.filterPathSources();
    if (!result.ok) {
      setMessage(result.message);
      setPathSources(null);
      return;
    }
    setPathSources(result.value);
  };
  useEffect(() => {
    if (needsPath) readPathSources();
  }, [needsPath, filterId, active]);

  if (!available) return null;
  if (!catalogue) {
    return (
      <section className="photo-editor__advanced-group" aria-label="参数滤镜" data-filter-panel="true">
        <span className="photo-editor__options-title">滤镜</span>
        <span className="photo-editor__option-hint">{message ?? "正在读取滤镜清单…"}</span>
      </section>
    );
  }
  if (!entry) return null;

  const groups = catalogueCategories(catalogue);

  /** 首次进入：没有活动草稿就走 begin，否则 update。 */
  const start = (id: string, next: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    const result = features.beginFilter(id, next);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    adopt(result.value.filter, result.value.params, true);
  };

  const update = (next: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    const result = features.updateFilter(next);
    setBusy(false);
    if (!result.ok) {
      // 非法输入不提交，也不把上一份有效预览当成新输入。
      setMessage(result.message);
      return;
    }
    adopt(result.value.filter, result.value.params, true);
  };

  const adopt = (id: string, canonical: Record<string, unknown>, preview: boolean) => {
    setFilterId(id);
    setParams(canonical);
    setGeometry(geometryOf(catalogue.filters.find((candidate) => candidate.id === id), canonical));
    setActive(true);
    setMessage(null);
    if (preview) onChanged?.();
  };

  /** 换滤镜先取消活动草稿：两套参数不能混在同一次提交里。 */
  const choose = (next: FilterEntry) => {
    if (next.id === entry.id && active) return;
    if (active) features.cancelFilter();
    setActive(false);
    setFilterId(next.id);
    const defaults = defaultParams(next);
    setParams(defaults);
    // 模糊画廊先放一个默认控制点/路径：没有几何就没有可调项（具体用哪个由命令声明决定）。
    setGeometry(next.kind === "blurGallery" ? geometryOf(next, defaults) : emptyGeometry());
    setMessage(null);
    // 滤镜库选中即用内核默认组合预览（画廊没有单值参数，空栈会被内核拒绝）。
    if (next.kind === "galleryStack" && defaultStack) {
      const preview = stackParams(defaultStack, defaultParams(next));
      if (preview) start(next.id, preview);
    }
  };

  /** 当前输入：有草稿就更新，没有就按这份输入开始。 */
  const apply = (next: Record<string, unknown>) => {
    if (active) update(next);
    else start(entry.id, next);
  };

  const setScalar = (spec: FilterParamSpec, raw: unknown) => {
    const value = coerceParam(spec, raw);
    if (value === null) {
      setMessage(`${spec.key} 的取值无效`);
      return;
    }
    apply({ ...params, [spec.key]: value });
  };

  const finish = (commit: boolean) => {
    if (!commit) {
      features.cancelFilter();
      setActive(false);
      setMessage(null);
      return;
    }
    const used = entry.label;
    const result = features.commitFilter();
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setActive(false);
    setMessage(null);
    setLast(used);
    onChanged?.();
  };

  const repeat = () => {
    const result = features.repeatLastFilter();
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    adopt(result.value.filter, result.value.params, true);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="参数滤镜" data-filter-panel="true" data-filter-kind={entry.kind}>
      <span className="photo-editor__options-title">滤镜</span>
      <div className="photo-editor__filter-quick">
        {FILTER_TOOLS.map((tool) => {
          const target = catalogue.filters.find((candidate) => candidate.id === tool.id);
          return (
            <Button
              key={tool.id}
              size="sm"
              tone="ghost"
              disabled={readonly || busy || !target}
              onClick={() => {
                if (!target) return;
                if (active) features.cancelFilter();
                setActive(false);
                start(target.id, { ...defaultParams(target), [tool.key]: tool.value });
              }}
            >{tool.label}</Button>
          );
        })}
        <Button
          size="sm"
          tone="ghost"
          disabled={readonly || busy || active || !last}
          title={last ? `重复：${last}` : "还没有可重复的滤镜"}
          onClick={repeat}
        >重复上次{last ? `（${last}）` : ""}</Button>
      </div>
      <label>
        分类
        <select
          disabled={readonly || busy}
          value={groups.find((group) => group.filters.some((candidate) => candidate.id === entry.id))?.category ?? ""}
          onChange={(event) => {
            const group = groups.find((candidate) => candidate.category === event.currentTarget.value);
            const first = group?.filters[0];
            if (first) choose(first);
          }}
        >
          {groups.map((group) => <option key={group.category} value={group.category}>{group.category}</option>)}
        </select>
      </label>
      <label>
        滤镜
        <select
          disabled={readonly || busy}
          value={entry.id}
          onChange={(event) => {
            const next = catalogue.filters.find((candidate) => candidate.id === event.currentTarget.value);
            if (next) choose(next);
          }}
        >
          {groups.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.filters.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      {entry.kind === "gallery" ? (
        <span className="photo-editor__option-hint">单层画廊滤镜：参数与「滤镜库」组合里的同名效果一致。</span>
      ) : null}

      {scalarParams(entry).map((spec) => (
        <FilterParamControl
          key={spec.key}
          spec={spec}
          params={params}
          disabled={readonly || busy}
          onChange={(value) => setScalar(spec, value)}
        />
      ))}

      {/* 火焰跟随的路径：`path` 是已保存路径的名字，不是坐标。 */}
      {needsPath ? (
        <div className="photo-editor__filter-flame-path" data-filter-flame-path={pathSources === null ? "unavailable" : "ready"}>
          <span className="photo-editor__option-hint">
            火焰沿哪条路径延烧。留空表示跟随工作路径（没有工作路径时用第一条已保存路径）。
          </span>
          {pathSources === null ? (
            <span className="photo-editor__option-hint">当前运行时不提供路径列表，火焰只能跟随默认路径。</span>
          ) : (
            <label>
              路径
              <select
                value={flamePath(params) ?? ""}
                disabled={readonly || busy}
                onChange={(event) => apply(withFlamePath(params, event.currentTarget.value === "" ? null : event.currentTarget.value, entry))}
              >
                <option value="">{pathSources.hasWorkPath ? "工作路径（默认）" : "第一条已保存路径（默认）"}</option>
                {pathSources.paths.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          {pathSources === null ? null : (
            <Button size="sm" tone="ghost" disabled={readonly || busy} onClick={readPathSources}>刷新路径列表</Button>
          )}
        </div>
      ) : null}

      {/* Camera Raw 的摄影调节：曲线 / HSL / 色彩分级都由命令声明驱动，没有声明就不画。 */}
      {declaresParam(entry, "pointCurve") ? (
        <CameraRawToneEditor
          params={params}
          entry={entry}
          disabled={readonly || busy}
          onChange={(next) => apply(next)}
        />
      ) : null}

      {declaresParam(entry, "lights") ? (
        <LightsEditor
          lights={filterLights(params, FILTER_LIMITS.maxPins)}
          disabled={readonly || busy}
          onChange={(lights) => apply(withLights(params, lights, entry))}
        />
      ) : null}

      {entry.kind === "galleryStack" ? (
        <GalleryStackEditor
          catalogue={catalogue}
          effects={geometry.effects.length > 0 ? geometry.effects : defaultStack ?? []}
          disabled={readonly || busy}
          onInvalid={setMessage}
          onChange={(effects) => {
            const next = stackParams(effects, params);
            if (!next) {
              setMessage("滤镜库至少要有一个可见效果");
              return;
            }
            setGeometry({ ...geometry, effects });
            apply(next);
          }}
        />
      ) : null}

      {/* 移轴模糊没有图内控制点字段（几何就是中心/角度/焦点带），不画一个写不回去的编辑器。 */}
      {entry.kind === "blurGallery" && declaresParam(entry, "pins") ? (
        <BlurGalleryEditor
          entry={entry}
          pins={geometry.pins}
          blur={typeof params.blur === "number" ? params.blur : 15}
          disabled={readonly || busy}
          onChange={(pins) => {
            setGeometry({ ...geometry, pins });
            apply(withBlurPins(params, pins, entry));
          }}
        />
      ) : null}

      {entry.kind === "blurGallery" && declaresParam(entry, "paths") ? (
        <PathBlurEditor
          paths={geometry.paths}
          speed={typeof params.speed === "number" ? params.speed : 50}
          taper={typeof params.taper === "number" ? params.taper : 0}
          disabled={readonly || busy}
          onChange={(paths) => {
            setGeometry({ ...geometry, paths });
            apply(withBlurPaths(params, paths, entry));
          }}
        />
      ) : null}

      {declaresParam(entry, "kernel") ? (
        <KernelEditor
          kernel={filterKernel(params)}
          disabled={readonly || busy}
          onChange={(kernel) => apply(withKernel(params, kernel, entry))}
        />
      ) : null}

      {declaresParam(entry, "points") && entry.id === "filter.distort.shear" ? (
        <ShearEditor
          points={shearPoints(params)}
          amount={typeof params.amount === "number" ? params.amount : 0}
          disabled={readonly || busy}
          onChange={(points) => apply(withShearPoints(params, points, entry))}
        />
      ) : null}

      {entry.kind === "vanishingPoint" ? (
        <VanishingPointEditor
          planes={geometry.planes}
          clones={vanishingClones(params, FILTER_LIMITS.maxPins)}
          size={{ width: documentSize.width, height: documentSize.height }}
          disabled={readonly || busy}
          onChange={(planes) => {
            setGeometry({ ...geometry, planes });
            apply(withPlanes(params, planes));
          }}
          onClones={(clones) => apply(withClones(params, clones, entry))}
          pastes={vanishingPastes(params, geometry.planes.length, FILTER_LIMITS.maxPins)}
          layers={layerSources}
          onPastes={(pastes) => apply(withPastes(params, pastes, entry))}
          onRefreshLayers={readLayerSources}
        />
      ) : null}

      {entry.id === "filter.adaptiveWideAngle" ? (
        <WideAngleEditor
          constraints={geometry.constraints}
          size={{ width: documentSize.width, height: documentSize.height }}
          disabled={readonly || busy}
          onChange={(constraints) => {
            setGeometry({ ...geometry, constraints });
            apply(withConstraints(params, constraints));
          }}
        />
      ) : null}

      {declaresParam(entry, "straighten") ? (
        <StraightenEditor
          line={geometry.straighten}
          size={{ width: documentSize.width, height: documentSize.height }}
          disabled={readonly || busy}
          onChange={(line) => {
            setGeometry({ ...geometry, straighten: line });
            apply(withStraighten(params, line, { width: documentSize.width, height: documentSize.height }, entry));
          }}
        />
      ) : null}

      {entry.needsMap ? (
        mapSources === null ? (
          // 端口缺失或读取失败：不画没有候选的下拉框，直接说明为什么选不了来源。
          <span className="photo-editor__option-hint">位移图来源不可用：当前运行时未接通文档列表，置换滤镜无法选择位移图。</span>
        ) : (
          <DisplaceMapPicker
            sources={mapSources}
            value={typeof params.mapDocument === "string" && mapSources.some((source) => source.name === params.mapDocument) ? params.mapDocument : ""}
            missing={typeof params.mapDocument === "string" && params.mapDocument !== "" && !mapSources.some((source) => source.name === params.mapDocument) ? params.mapDocument : null}
            layer={mapLayerOf(params)}
            disabled={readonly || busy}
            onRefresh={readMapSources}
            onChange={(source) => apply(withMapDocument(params, source))}
            onLayer={(layer) => apply(withMapLayer(params, layer))}
          />
        )
      ) : null}

      <div className="photo-editor__filter-actions">
        <Button size="sm" disabled={readonly || busy || !active} onClick={() => finish(true)}>确认</Button>
        <Button size="sm" tone="ghost" disabled={!active} onClick={() => finish(false)}>取消</Button>
      </div>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/**
 * 切变曲线编辑器：`[t, offset]` 点列表，`t` 从上到下，`offset` 是半画布宽倍数。
 *
 * 没有自定义点时显示内核按 `amount` 生成的那条三点曲线——否则面板会画成「空曲线」，用户看不出
 * 当前实际形状，也无从判断拖动一点会从哪里开始。
 */
function ShearEditor({ points, amount, disabled, onChange }: {
  points: FilterShearPoint[];
  amount: number;
  disabled: boolean;
  onChange: (points: FilterShearPoint[]) => void;
}) {
  const custom = points.length > 0;
  const shown = custom ? points : defaultShearPoints(amount);
  return (
    <div
      className="photo-editor__filter-curve"
      data-filter-shear={custom ? "custom" : "amount"}
      data-filter-shear-points={shown.length}
    >
      <span className="photo-editor__option-hint">
        {custom
          ? `切变曲线（${shown.length} 个点；左侧是自上而下的位置 0–1，右侧是水平位移，1 = 半个画布宽）`
          : `当前按 amount=${amount} 生成缺省曲线；改动任一点即改为自定义曲线`}
      </span>
      {shown.map(([t, offset], index) => (
        <span key={index} className="photo-editor__filter-curve-point" data-filter-shear-point={index}>
          <input
            type="number" min={0} max={1} step={0.01} value={t} disabled={disabled}
            onChange={(event) => onChange(moveShearPoint(shown, index, [Number(event.currentTarget.value), offset]))}
          />
          <input
            type="number" min={-1} max={1} step={0.01} value={offset} disabled={disabled}
            onChange={(event) => onChange(moveShearPoint(shown, index, [t, Number(event.currentTarget.value)]))}
          />
          <Button
            size="sm" tone="ghost" disabled={disabled || shown.length <= 1}
            onClick={() => onChange(removeShearPoint(shown, index))}
          >删除</Button>
        </span>
      ))}
      <span className="photo-editor__filter-curve-actions">
        <Button size="sm" disabled={disabled} onClick={() => onChange(addShearPoint(shown))}>添加点</Button>
        {/* 清空即交还给 `amount`：内核在无 `points` 时按 amount 生成三点曲线。 */}
        <Button size="sm" tone="ghost" disabled={disabled || !custom} onClick={() => onChange([])}>改用 amount</Button>
      </span>
    </div>
  );
}

/** 画廊滤镜的 `glowColor`：画廊编辑器此前跳过所有 `resource`，这一项因此没有入口。 */
function GalleryColorControl({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label data-gallery-color="glowColor">
      glowColor
      <input type="color" value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

/** 一个标量参数：数字框 + 滑杆（布尔/选项/颜色各有形态）。 */
function FilterParamControl({ spec, params, disabled, onChange }: {
  spec: FilterParamSpec;
  params: Record<string, unknown>;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const value = currentValue(spec, params);
  if (spec.kind === "bool") {
    return (
      <label data-filter-param={spec.key}>
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        {spec.key}
      </label>
    );
  }
  if (spec.kind === "choice") {
    return (
      <label data-filter-param={spec.key}>
        {spec.key}
        <select value={String(value ?? "")} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
          {spec.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
    );
  }
  if (spec.kind === "color") {
    return (
      <label data-filter-param={spec.key}>
        {spec.key}
        <input type="color" value={String(value ?? "#000000")} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
      </label>
    );
  }
  const min = spec.min ?? undefined;
  const max = spec.max ?? undefined;
  const step = paramStep(spec);
  return (
    <label data-filter-param={spec.key}>
      {spec.key}
      {min !== undefined && max !== undefined ? (
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(value ?? min)}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
      ) : null}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value ?? 0)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

/** 画廊滤镜下拉：按分类分组，顺序与内核目录一致。 */
function GallerySelect({ catalogue, value, disabled, onChange }: {
  catalogue: FilterCatalogue;
  value: string;
  disabled: boolean;
  onChange: (key: string) => void;
}) {
  const gallery = catalogue.gallery;
  const categories = gallery.categories.length > 0
    ? gallery.categories
    : [...new Set(gallery.filters.map((filter) => filter.category))];
  return (
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
      {categories.map((category) => (
        <optgroup key={category} label={category}>
          {gallery.filters.filter((filter) => filter.category === category)
            .map((filter) => <option key={filter.key} value={filter.key}>{filter.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** 滤镜库组合：效果栈顺序/可见性/参数，每次改动都重跑候选图。 */
function GalleryStackEditor({ catalogue, effects, disabled, onInvalid, onChange }: {
  catalogue: FilterCatalogue;
  effects: FilterStackEffect[];
  disabled: boolean;
  onInvalid: (message: string) => void;
  onChange: (effects: FilterStackEffect[]) => void;
}) {
  const gallery = catalogue.gallery;
  const entryOf = (key: string) => gallery.filters.find((candidate) => candidate.key === key);
  const [adding, setAdding] = useState<string>(gallery.filters[0]?.key ?? "");
  const limit = catalogue.limits.maxEffects;

  if (gallery.filters.length === 0) {
    return <span className="photo-editor__option-hint">滤镜库目录为空，无法组合效果。</span>;
  }

  return (
    <div className="photo-editor__filter-stack" data-filter-stack={effects.length}>
      <span className="photo-editor__option-hint">效果栈（自下而上，最多 {limit} 层；至少保留一个可见效果）</span>
      {effects.map((effect, index) => {
        const meta = entryOf(effect.filter);
        return (
          <div key={`${effect.filter}-${index}`} className="photo-editor__filter-stack-item" data-filter-effect={effect.filter}>
            <div className="photo-editor__filter-stack-row">
              <GallerySelect
                catalogue={catalogue}
                value={effect.filter}
                disabled={disabled}
                onChange={(key) => {
                  const next = entryOf(key);
                  if (next) onChange(replaceEffect(effects, index, next));
                }}
              />
              <label>
                <input
                  type="checkbox"
                  checked={effect.visible}
                  disabled={disabled}
                  onChange={() => onChange(toggleEffect(effects, index))}
                />可见
              </label>
              <Button size="sm" tone="ghost" disabled={disabled || index === 0} onClick={() => onChange(moveEffect(effects, index, -1))}>上移</Button>
              <Button size="sm" tone="ghost" disabled={disabled || index === effects.length - 1} onClick={() => onChange(moveEffect(effects, index, 1))}>下移</Button>
              <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(removeEffect(effects, index))}>移除</Button>
            </div>
            {(meta?.params ?? []).filter((spec) => spec.kind !== "resource" && spec.key !== "seed").map((spec) => (
              <FilterParamControl
                key={spec.key}
                spec={spec}
                params={effect.params}
                disabled={disabled}
                onChange={(value) => {
                  const coerced = coerceParam(spec, value);
                  if (coerced === null) {
                    onInvalid(`${effect.filter} 的 ${spec.key} 取值无效`);
                    return;
                  }
                  onChange(setEffectParam(effects, index, spec.key, coerced));
                }}
              />
            ))}
            {/* 画廊的 `glowColor` 是唯一的 resource 参数（其余 resource 都是会话颜色），
                跳过所有 resource 会让「霓虹光晕的颜色」永远停在默认值。 */}
            {meta && meta.params.some((spec) => spec.key === "glowColor") ? (
              <GalleryColorControl
                value={typeof effect.params.glowColor === "string" ? effect.params.glowColor : "#000000"}
                disabled={disabled}
                onChange={(value) => onChange(setEffectParam(effects, index, "glowColor", value))}
              />
            ) : null}
            {meta ? null : <span className="photo-editor__option-hint">未知滤镜 {effect.filter}，请更换或移除。</span>}
          </div>
        );
      })}
      <div className="photo-editor__filter-stack-row" data-filter-stack-add="true">
        <GallerySelect catalogue={catalogue} value={adding} disabled={disabled} onChange={setAdding} />
        <Button
          size="sm"
          disabled={disabled || effects.length >= limit}
          onClick={() => {
            const meta = entryOf(adding) ?? gallery.filters[0];
            if (!meta) return;
            onChange(addEffect(effects, newEffect(meta), limit));
          }}
        >添加效果</Button>
      </div>
    </div>
  );
}

/** 模糊画廊：图内控制点列表 + 每点模糊量（坐标是 0–1 相对值）。 */
function BlurGalleryEditor({ entry, pins, blur, disabled, onChange }: {
  entry: FilterEntry;
  pins: FilterPin[];
  blur: number;
  disabled: boolean;
  onChange: (pins: FilterPin[]) => void;
}) {
  const max = FILTER_LIMITS.maxPins;
  // 旋转模糊的控制点模糊量是角度（`blurAngle`，0–360），不是像素半径。
  const key = blurPinKey(entry);
  const spec = entry.params.find((candidate) => candidate.key === key);
  const limit = typeof spec?.max === "number" ? spec.max : 500;
  const label = key === "blurAngle" ? "旋转角度" : "模糊";
  return (
    <div className="photo-editor__filter-pins" data-filter-pins={pins.length} data-filter-pin-key={key}>
      <span className="photo-editor__option-hint">
        控制点坐标为画布相对位置（0–1）；改动即重算候选图。
      </span>
      {pins.map((pin, index) => (
        <div key={index} className="photo-editor__filter-pin" data-filter-pin={index}>
          <label>
            X
            <input
              type="number" min={0} max={1} step={0.01} value={Number(pin.x.toFixed(3))} disabled={disabled}
              onChange={(event) => onChange(pins.map((item, at) => (at === index ? { ...item, x: Number(event.currentTarget.value) } : item)))}
            />
          </label>
          <label>
            Y
            <input
              type="number" min={0} max={1} step={0.01} value={Number(pin.y.toFixed(3))} disabled={disabled}
              onChange={(event) => onChange(pins.map((item, at) => (at === index ? { ...item, y: Number(event.currentTarget.value) } : item)))}
            />
          </label>
          <label>
            {label}
            <input
              type="range" min={0} max={limit} step={1} value={pin.blur} disabled={disabled}
              onChange={(event) => onChange(pins.map((item, at) => (at === index ? { ...item, blur: Number(event.currentTarget.value) } : item)))}
            />
          </label>
          <Button size="sm" tone="ghost" disabled={disabled || pins.length <= 1} onClick={() => onChange(removePin(pins, index))}>移除</Button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={disabled || pins.length >= max}
        onClick={() => onChange(addPin(pins, { x: 0.5, y: 0.5, blur }, max))}
      >添加控制点</Button>
    </div>
  );
}

/** 自定卷积：5×5 核，行主序（中心是第 13 格）。恒等核之外的值才是「自定」的意义。 */
function KernelEditor({ kernel, disabled, onChange }: {
  kernel: number[];
  disabled: boolean;
  onChange: (kernel: number[]) => void;
}) {
  // 行数与列数由核尺寸决定，不在模板里写死 5，避免和内核侧的 25 项约定漂移。
  const side = Math.round(Math.sqrt(FILTER_KERNEL_SIZE));
  return (
    <div className="photo-editor__filter-kernel" data-filter-kernel={kernel.length}>
      <span className="photo-editor__option-hint">
        自定卷积：5×5 系数，中心格是当前像素的权重；恒等核（中心 1、其余 0）不改变画面。
      </span>
      <div className="photo-editor__filter-kernel-grid" style={{ gridTemplateColumns: `repeat(${side}, minmax(0, 1fr))` }}>
        {kernel.map((value, index) => (
          <input
            key={index}
            type="number" min={-999} max={999} step={1} value={value} disabled={disabled}
            data-filter-kernel-cell={index}
            onChange={(event) => {
              const next = [...kernel];
              next[index] = Number(event.currentTarget.value);
              onChange(next);
            }}
          />
        ))}
      </div>
      <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(identityKernel())}>恢复恒等核</Button>
    </div>
  );
}

/** 路径模糊：每条路径的起止点（0–1 相对坐标）+ 速度 + 锥度。 */
function PathBlurEditor({ paths, speed, taper, disabled, onChange }: {
  paths: FilterBlurPath[];
  speed: number;
  taper: number;
  disabled: boolean;
  onChange: (paths: FilterBlurPath[]) => void;
}) {
  const max = FILTER_LIMITS.maxPins;
  const patch = (index: number, next: Partial<FilterBlurPath>) =>
    onChange(paths.map((path, at) => (at === index ? { ...path, ...next } : path)));
  const movePoint = (index: number, point: number, x: number, y: number) =>
    onChange(paths.map((path, at) => (
      at === index ? { ...path, points: path.points.map((p, pi) => (pi === point ? [x, y] as [number, number] : p)) } : path
    )));
  return (
    <div className="photo-editor__filter-paths" data-filter-paths={paths.length}>
      <span className="photo-editor__option-hint">
        路径模糊：每条路径的端点用画布相对位置（0–1）定义方向，速度与锥度决定模糊长度与衰减。
      </span>
      {paths.map((path, index) => (
        <div key={index} className="photo-editor__filter-path" data-filter-path={index}>
          {path.points.map(([x, y], point) => (
            <span key={point} className="photo-editor__filter-path-point">
              <label>
                {`起止 ${point + 1} X`}
                <input
                  type="number" min={0} max={1} step={0.01} value={Number(x.toFixed(3))} disabled={disabled}
                  onChange={(event) => movePoint(index, point, Number(event.currentTarget.value), y)}
                />
              </label>
              <label>
                {`起止 ${point + 1} Y`}
                <input
                  type="number" min={0} max={1} step={0.01} value={Number(y.toFixed(3))} disabled={disabled}
                  onChange={(event) => movePoint(index, point, x, Number(event.currentTarget.value))}
                />
              </label>
            </span>
          ))}
          <label>
            速度
            <input
              type="range" min={0} max={500} step={1} value={path.speed} disabled={disabled}
              onChange={(event) => patch(index, { speed: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            锥度
            <input
              type="range" min={0} max={100} step={1} value={path.taper} disabled={disabled}
              onChange={(event) => patch(index, { taper: Number(event.currentTarget.value) })}
            />
          </label>
          <Button
            size="sm" tone="ghost" disabled={disabled || paths.length <= 1}
            onClick={() => onChange(paths.filter((_, at) => at !== index))}
          >移除路径</Button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={disabled || paths.length >= max}
        onClick={() => onChange([...paths, { points: [[0.2, 0.5], [0.8, 0.5]], speed, taper }])}
      >添加路径</Button>
    </div>
  );
}

/** 消失点：透视平面列表 + 角点编辑（最多 8 个平面，与内核一致；角点是文档像素）。 */
function VanishingPointEditor({ planes, clones, pastes, layers, size, disabled, onChange, onClones, onPastes, onRefreshLayers }: {
  planes: FilterPlane[];
  clones: FilterCloneStroke[];
  pastes: FilterPaste[];
  layers: FilterLayerSource[] | null;
  size: FilterDocumentSize;
  disabled: boolean;
  onChange: (planes: FilterPlane[]) => void;
  onClones: (clones: FilterCloneStroke[]) => void;
  onPastes: (pastes: FilterPaste[]) => void;
  onRefreshLayers: () => void;
}) {
  const max = FILTER_LIMITS.maxPlanes;
  const step = Math.max(1, Math.round(Math.max(size.width, size.height) / 1000));
  return (
    <div className="photo-editor__filter-planes" data-filter-planes={planes.length}>
      <span className="photo-editor__option-hint">
        {planes.length === 0
          ? "至少需要一个透视平面；未绘制时无法预览。"
          : `角点是文档像素坐标（画布 ${size.width}×${size.height}）；平面顺序决定贴合与撕出。`}
      </span>
      {planes.map((plane, index) => (
        <div key={index} className="photo-editor__filter-plane" data-filter-plane={index}>
          {plane.corners.map(([x, y], corner) => (
            <label key={corner}>
              {`平面 ${index + 1} 角 ${corner + 1}`}
              <input
                type="number" min={0} max={size.width} step={step} value={Number(x.toFixed(2))} disabled={disabled}
                onChange={(event) => onChange(setPlaneCorner(planes, index, corner, [Number(event.currentTarget.value), y], size))}
              />
              <input
                type="number" min={0} max={size.height} step={step} value={Number(y.toFixed(2))} disabled={disabled}
                onChange={(event) => onChange(setPlaneCorner(planes, index, corner, [x, Number(event.currentTarget.value)], size))}
              />
            </label>
          ))}
          <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(removePlane(planes, index))}>移除平面</Button>
        </div>
      ))}
      <Button size="sm" disabled={disabled || planes.length >= max} onClick={() => onChange(addPlane(planes, size, undefined, max))}>添加平面</Button>
      {/*
        透视克隆：有平面才谈得上沿透视落笔，没有平面时内核直接拒绝整条命令。
        坐标一律是文档像素（与内核 `clone.source/points` 同单位），不是 0–1 相对值。
      */}
      {planes.length === 0 ? (
        <span className="photo-editor__option-hint">先画一个透视平面，再做透视克隆。</span>
      ) : (
        <div className="photo-editor__filter-clones" data-filter-clones={clones.length}>
          <span className="photo-editor__option-hint">
            {`透视克隆：来源点是取样位置，落笔点是笔画路径（都是文档像素，画布 ${size.width}×${size.height}）；笔画按平面透视换算。`}
          </span>
          {clones.map((clone, index) => (
            <div key={index} className="photo-editor__filter-clone" data-filter-clone={index}>
              <label>
                来源 X
                <input
                  type="number" min={0} max={size.width} step={1} value={Math.round(clone.source[0])} disabled={disabled}
                  onChange={(event) => onClones(setCloneGeometry(clones, index, "source", [Number(event.currentTarget.value), clone.source[1]], size))}
                />
              </label>
              <label>
                来源 Y
                <input
                  type="number" min={0} max={size.height} step={1} value={Math.round(clone.source[1])} disabled={disabled}
                  onChange={(event) => onClones(setCloneGeometry(clones, index, "source", [clone.source[0], Number(event.currentTarget.value)], size))}
                />
              </label>
              {clone.points.map(([x, y], point) => (
                <span key={point} className="photo-editor__filter-clone-point">
                  <label>
                    {`落笔 ${point + 1} X`}
                    <input
                      type="number" min={0} max={size.width} step={1} value={Math.round(x)} disabled={disabled}
                      onChange={(event) => onClones(setCloneGeometry(clones, index, point, [Number(event.currentTarget.value), y], size))}
                    />
                  </label>
                  <label>
                    {`落笔 ${point + 1} Y`}
                    <input
                      type="number" min={0} max={size.height} step={1} value={Math.round(y)} disabled={disabled}
                      onChange={(event) => onClones(setCloneGeometry(clones, index, point, [x, Number(event.currentTarget.value)], size))}
                    />
                  </label>
                </span>
              ))}
              <label>
                笔尖
                <input
                  type="range" min={1} max={500} step={1} value={clone.size} disabled={disabled}
                  onChange={(event) => onClones(setCloneBrush(clones, index, { size: Number(event.currentTarget.value) }))}
                />
              </label>
              <label>
                硬度
                <input
                  type="range" min={0} max={100} step={1} value={clone.hardness} disabled={disabled}
                  onChange={(event) => onClones(setCloneBrush(clones, index, { hardness: Number(event.currentTarget.value) }))}
                />
              </label>
              <label>
                不透明度
                <input
                  type="range" min={0} max={100} step={1} value={clone.opacity} disabled={disabled}
                  onChange={(event) => onClones(setCloneBrush(clones, index, { opacity: Number(event.currentTarget.value) }))}
                />
              </label>
              <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onClones(removeClone(clones, index))}>移除克隆</Button>
            </div>
          ))}
          <Button
            size="sm"
            disabled={disabled || clones.length >= FILTER_LIMITS.maxPins}
            onClick={() => onClones(addClone(clones, size, undefined, FILTER_LIMITS.maxPins))}
          >添加透视克隆</Button>
        </div>
      )}

      {/*
        透视粘贴：把某个图层（或剪贴板）按平面透视贴上去。
        来源图层靠本域的 `filterLayerSources` 端口列出——内核 `paste[].layer` 只认图层 id，
        没有这个列表时用户除了「先复制到剪贴板」就没有别的入口。
      */}
      {planes.length === 0 ? null : (
        <div className="photo-editor__filter-pastes" data-filter-pastes={pastes.length}>
          <span className="photo-editor__option-hint">
            透视粘贴：把来源图层按平面透视贴到平面上；`at` 是相对平面内容框的位置（0–1），宽度是相对平面宽度的比例。
          </span>
          {layers === null ? (
            <span className="photo-editor__option-hint">
              当前运行时不提供图层来源，粘贴只能在先复制内容到剪贴板后使用。
            </span>
          ) : layers.length === 0 ? (
            <span className="photo-editor__option-hint">当前文档没有可作为来源的像素图层。</span>
          ) : null}
          {pastes.map((paste, index) => (
            <div key={index} className="photo-editor__filter-paste" data-filter-paste={index}>
              <label>
                平面
                <select
                  value={paste.plane} disabled={disabled}
                  onChange={(event) => onPastes(setPaste(pastes, index, { plane: Number(event.currentTarget.value) }, planes.length))}
                >
                  {planes.map((_, plane) => <option key={plane} value={plane}>{`平面 ${plane + 1}`}</option>)}
                </select>
              </label>
              <label>
                来源图层
                <select
                  value={paste.layer === null ? "" : String(paste.layer)} disabled={disabled}
                  onChange={(event) => onPastes(setPaste(pastes, index, { layer: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) }, planes.length))}
                >
                  <option value="">剪贴板</option>
                  {(layers ?? []).map((layer) => (
                    <option key={layer.id} value={layer.id}>{`${layer.name}（${layer.width}×${layer.height}）`}</option>
                  ))}
                </select>
              </label>
              {(["水平", "垂直"] as const).map((label, axis) => (
                <label key={label}>
                  {label}
                  <input
                    type="range" min={0} max={1} step={0.01} value={paste.at[axis]} disabled={disabled}
                    onChange={(event) => {
                      const at: [number, number] = [paste.at[0], paste.at[1]];
                      at[axis] = Number(event.currentTarget.value);
                      onPastes(setPaste(pastes, index, { at }, planes.length));
                    }}
                  />
                </label>
              ))}
              <label>
                宽度
                <input
                  type="range" min={0.01} max={2} step={0.01} value={paste.width} disabled={disabled}
                  onChange={(event) => onPastes(setPaste(pastes, index, { width: Number(event.currentTarget.value) }, planes.length))}
                />
              </label>
              <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onPastes(removePaste(pastes, index))}>移除粘贴</Button>
            </div>
          ))}
          <span className="photo-editor__filter-paste-actions">
            <Button
              size="sm"
              disabled={disabled || pastes.length >= FILTER_LIMITS.maxPins}
              onClick={() => {
                // 新粘贴默认用活动图层：多数人想贴的就是当前在编辑的那一层。
                const preferred = layers?.find((layer) => layer.active) ?? layers?.[0] ?? null;
                onPastes(addPaste(pastes, newPaste(0, preferred?.id ?? null), FILTER_LIMITS.maxPins));
              }}
            >添加粘贴</Button>
            {layers === null ? null : (
              <Button size="sm" tone="ghost" disabled={disabled} onClick={onRefreshLayers}>刷新图层来源</Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** 自适应广角：约束线列表（方向决定水平/垂直校正；端点是文档像素）。 */
function WideAngleEditor({ constraints, size, disabled, onChange }: {
  constraints: FilterConstraint[];
  size: FilterDocumentSize;
  disabled: boolean;
  onChange: (constraints: FilterConstraint[]) => void;
}) {
  return (
    <div className="photo-editor__filter-constraints" data-filter-constraints={constraints.length}>
      <span className="photo-editor__option-hint">
        {`约束线：把应当是直线的地方连起来，越多越准（端点用文档像素，画布 ${size.width}×${size.height}）。`}
      </span>
      {constraints.map((constraint, index) => (
        <div key={index} className="photo-editor__filter-constraint" data-filter-constraint={index}>
          <span>{`线 ${index + 1}：(${constraint.a[0].toFixed(0)}, ${constraint.a[1].toFixed(0)}) → (${constraint.b[0].toFixed(0)}, ${constraint.b[1].toFixed(0)})`}</span>
          <select
            value={constraint.orientation}
            disabled={disabled}
            onChange={(event) => {
              const orientation = event.currentTarget.value as FilterConstraint["orientation"];
              onChange(constraints.map((item, at) => (at === index ? { ...item, orientation } : item)));
            }}
          >
            <option value="free">自由</option>
            <option value="horizontal">水平</option>
            <option value="vertical">垂直</option>
          </select>
          <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(removeConstraint(constraints, index))}>移除</Button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={disabled || constraints.length >= FILTER_LIMITS.maxResourcePoints}
        onClick={() => onChange(addConstraint(constraints, size))}
      >添加约束线</Button>
    </div>
  );
}

/**
 * Camera Raw 的摄影调节：点曲线、HSL 八段与色彩分级转盘。
 *
 * 这三组参数在上游是「有控件、可直接改」的摄影调节，而它们全是结构型参数（`pointCurve*`、
 * `hslHue/Sat/Lum`、`gradeShadows/Midtones/Highlights/Global`）。只靠标量列表时它们既不出现在
 * 面板里、也不会被写进草稿——选中 Camera Raw 就只能用一半功能。这里按命令声明逐组渲染，
 * 并且每组都只写内核真的声明过的那几个字段。
 */
function CameraRawToneEditor({ params, entry, disabled, onChange }: {
  params: Record<string, unknown>;
  entry: FilterEntry;
  disabled: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const channels = FILTER_CURVE_CHANNELS.filter((channel) => declaresParam(entry, channel));
  const hsl = filterHsl(params);
  const hslChannels = (["hslHue", "hslSat", "hslLum"] as const)
    .filter((channel) => declaresParam(entry, channel))
    .map((channel) => ({ channel, label: channel === "hslHue" ? "色相" : channel === "hslSat" ? "饱和度" : "明度", values: hsl[channel === "hslHue" ? "hue" : channel === "hslSat" ? "sat" : "lum"] }));
  const wheels = FILTER_GRADE_WHEELS.filter((wheel) => declaresParam(entry, wheel));
  const splitsVisible = declaresParam(entry, "curveSplits");
  const splits = curveSplits(params);
  return (
    <div className="photo-editor__filter-camera-raw" data-filter-camera-raw="true">
      <span className="photo-editor__option-hint">
        曲线坐标是 8 位色阶（0–255），输入必须递增且每段至少差 1；空曲线表示不调整。
      </span>
      {splitsVisible ? (
        <div className="photo-editor__filter-curve-splits" data-filter-curve-splits="true">
          <span className="photo-editor__option-hint">分离点：阴影 / 中间调 / 高光各自的作用范围（5–95）。</span>
          {(["阴影", "中间调", "高光"] as const).map((label, index) => (
            <label key={label}>
              {label}
              <input
                type="number" min={5} max={95} step={1} value={splits[index]} disabled={disabled}
                onChange={(event) => {
                  const next = [...splits];
                  // 三个分离点必须保持递增，否则内核按越界拒绝整次草稿。
                  const low = index === 0 ? 5 : splits[index - 1]!;
                  const high = index === 2 ? 95 : splits[index + 1]!;
                  next[index] = Math.min(high, Math.max(low, Number(event.currentTarget.value)));
                  onChange(withCurveSplits(params, next, entry));
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      {channels.map((channel) => (
        <CurveEditor
          key={channel}
          channel={channel}
          points={filterCurve(params, channel)}
          disabled={disabled}
          onChange={(points) => onChange(withCurve(params, channel, points, entry))}
        />
      ))}
      {hslChannels.length > 0 ? (
        <div className="photo-editor__filter-hsl" data-filter-hsl={hslChannels.length}>
          <span className="photo-editor__option-hint">HSL：八段色相的色相/饱和度/明度偏移（色相 ±30°，其余按百分比）。</span>
          {hslChannels.map(({ channel, label, values }) => (
            <div key={channel} className="photo-editor__filter-hsl-band" data-filter-hsl-channel={channel}>
              <span className="photo-editor__option-hint">{label}</span>
              {FILTER_HSL_BAND_NAMES.map((band, index) => (
                <label key={band} title={`${band}：${values[index]}`}>
                  {band}
                  <input
                    type="range" min={-100} max={100} step={1} value={values[index]} disabled={disabled}
                    onChange={(event) => {
                      const next = [...values];
                      next[index] = Number(event.currentTarget.value);
                      onChange(withHslBand(params, channel, next, entry));
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {wheels.length > 0 ? (
        <div className="photo-editor__filter-grades" data-filter-grades={wheels.length}>
          <span className="photo-editor__option-hint">色彩分级：每个转盘的色相 0–360°、饱和度 0–100、明度 −100–100。</span>
          {wheels.map((wheel) => {
            const value = filterWheel(params, wheel);
            const label = wheel === "gradeShadows" ? "阴影" : wheel === "gradeMidtones" ? "中间调" : wheel === "gradeHighlights" ? "高光" : "全局";
            return (
              <div key={wheel} className="photo-editor__filter-grade" data-filter-grade={wheel}>
                <span className="photo-editor__option-hint">{label}</span>
                <label>
                  色相
                  <input
                    type="range" min={0} max={360} step={1} value={value.hue} disabled={disabled}
                    onChange={(event) => onChange(withWheel(params, wheel, { ...value, hue: Number(event.currentTarget.value) }, entry))}
                  />
                </label>
                <label>
                  饱和度
                  <input
                    type="range" min={0} max={100} step={1} value={value.sat} disabled={disabled}
                    onChange={(event) => onChange(withWheel(params, wheel, { ...value, sat: Number(event.currentTarget.value) }, entry))}
                  />
                </label>
                <label>
                  明度
                  <input
                    type="range" min={-100} max={100} step={1} value={value.lum} disabled={disabled}
                    onChange={(event) => onChange(withWheel(params, wheel, { ...value, lum: Number(event.currentTarget.value) }, entry))}
                  />
                </label>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 一条点曲线：逐点编辑输入/输出，可加可删；点数不足两点时内核会拒绝，所以下限是 2。 */
function CurveEditor({ channel, points, disabled, onChange }: {
  channel: FilterCurveChannel;
  points: FilterCurvePoint[];
  disabled: boolean;
  onChange: (points: FilterCurvePoint[]) => void;
}) {
  const label = channel === "pointCurve" ? "复合" : channel === "pointCurveRed" ? "红" : channel === "pointCurveGreen" ? "绿" : "蓝";
  return (
    <div className="photo-editor__filter-curve" data-filter-curve={channel} data-filter-curve-points={points.length}>
      <span className="photo-editor__option-hint">{`${label}通道曲线（${points.length === 0 ? "未调整" : `${points.length} 个点`}）`}</span>
      {points.map(([x, y], index) => (
        <span key={index} className="photo-editor__filter-curve-point" data-filter-curve-point={index}>
          <input
            type="number" min={0} max={255} step={1} value={x} disabled={disabled}
            onChange={(event) => onChange(moveCurvePoint(points, index, [Number(event.currentTarget.value), y]))}
          />
          <input
            type="number" min={0} max={255} step={1} value={y} disabled={disabled}
            onChange={(event) => onChange(moveCurvePoint(points, index, [x, Number(event.currentTarget.value)]))}
          />
          <Button
            size="sm" tone="ghost" disabled={disabled || index === 0 || index === points.length - 1}
            onClick={() => onChange(removeCurvePoint(points, index))}
          >删除</Button>
        </span>
      ))}
      <span className="photo-editor__filter-curve-actions">
        <Button size="sm" disabled={disabled} onClick={() => onChange(addCurvePoint(points))}>添加点</Button>
        <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(identityCurve())}>恢复对角线</Button>
        <Button size="sm" tone="ghost" disabled={disabled || points.length === 0} onClick={() => onChange([])}>清空曲线</Button>
      </span>
    </div>
  );
}

/** 光照效果的光源组：每盏灯的类型/位置/目标/颜色/强度/锥角，可增删。 */
function LightsEditor({ lights, disabled, onChange }: {
  lights: FilterLight[];
  disabled: boolean;
  onChange: (lights: FilterLight[]) => void;
}) {
  const max = FILTER_LIMITS.maxPins;
  const patch = (index: number, next: Partial<FilterLight>) => onChange(moveLight(lights, index, next));
  const colour = (light: FilterLight): string =>
    `#${light.color.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
  const fromColour = (value: string): [number, number, number] => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return [255, 255, 255];
    const raw = match[1]!;
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
  };
  return (
    <div className="photo-editor__filter-lights" data-filter-lights={lights.length}>
      <span className="photo-editor__option-hint">
        光源位置与目标是相对画面的 0–1 分量；`z` 是高出表面的比例。给了光源组就不再使用顶层单灯字段。
      </span>
      {lights.map((light, index) => (
        <div key={index} className="photo-editor__filter-light" data-filter-light={index}>
          <label>
            类型
            <select
              value={light.kind} disabled={disabled}
              onChange={(event) => patch(index, { kind: event.currentTarget.value as FilterLight["kind"] })}
            >
              {FILTER_LIGHT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </label>
          {(["x", "y", "targetX", "targetY"] as const).map((key) => (
            <label key={key}>
              {key}
              <input
                type="range" min={0} max={1} step={0.01} value={light[key]} disabled={disabled}
                onChange={(event) => patch(index, { [key]: Number(event.currentTarget.value) } as Partial<FilterLight>)}
              />
            </label>
          ))}
          <label>
            z
            <input
              type="range" min={0} max={10} step={0.05} value={light.z} disabled={disabled}
              onChange={(event) => patch(index, { z: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            强度
            <input
              type="range" min={-100} max={100} step={1} value={light.intensity} disabled={disabled}
              onChange={(event) => patch(index, { intensity: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            锥角
            <input
              type="range" min={1} max={89} step={1} value={light.cone} disabled={disabled}
              onChange={(event) => patch(index, { cone: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            热点
            <input
              type="range" min={0} max={100} step={1} value={light.hotspot} disabled={disabled}
              onChange={(event) => patch(index, { hotspot: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            角度
            <input
              type="range" min={-180} max={180} step={1} value={light.angle} disabled={disabled}
              onChange={(event) => patch(index, { angle: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            仰角
            <input
              type="range" min={0} max={90} step={1} value={light.elevation} disabled={disabled}
              onChange={(event) => patch(index, { elevation: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            半径
            <input
              type="range" min={0} max={5} step={0.05} value={light.radius} disabled={disabled}
              onChange={(event) => patch(index, { radius: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            颜色
            <input
              type="color" value={colour(light)} disabled={disabled}
              onChange={(event) => patch(index, { color: fromColour(event.currentTarget.value) })}
            />
          </label>
          <Button size="sm" tone="ghost" disabled={disabled || lights.length <= 1} onClick={() => onChange(removeLight(lights, index))}>移除光源</Button>
        </div>
      ))}
      <Button size="sm" disabled={disabled || lights.length >= max} onClick={() => onChange(addLight(lights, newLight(), max))}>添加光源</Button>
    </div>
  );
}

/**
 * 镜头校正的拉直线：两点决定一个需要被拉直的参考方向。
 *
 * 端点用文档像素（与内核 `lens::straighten_angle` 同单位）；清除后滤镜不再做拉直旋转。
 */
function StraightenEditor({ line, size, disabled, onChange }: {
  line: FilterStraighten | null;
  size: FilterDocumentSize;
  disabled: boolean;
  onChange: (line: FilterStraighten | null) => void;
}) {
  const edit = (which: "a" | "b", at: 0 | 1, value: number) => {
    const base = line ?? newStraighten(size);
    const next: FilterStraighten = { a: [...base.a] as [number, number], b: [...base.b] as [number, number] };
    next[which][at] = value;
    onChange(next);
  };
  return (
    <div className="photo-editor__filter-straighten" data-filter-straighten={line ? "set" : "none"}>
      <span className="photo-editor__option-hint">
        {`拉直线：沿画面里应当水平的边连一条线（文档像素，画布 ${size.width}×${size.height}）；角度由两点算出。`}
      </span>
      {line === null ? (
        <Button size="sm" disabled={disabled} onClick={() => onChange(newStraighten(size))}>添加拉直线</Button>
      ) : (
        <div className="photo-editor__filter-straighten-row">
          {(["a", "b"] as const).map((which) => (
            <span key={which} className="photo-editor__filter-straighten-end">
              <label>
                {`${which === "a" ? "起点" : "终点"} X`}
                <input
                  type="number" min={0} max={size.width} step={1} value={line[which][0]} disabled={disabled}
                  onChange={(event) => edit(which, 0, Number(event.currentTarget.value))}
                />
              </label>
              <label>
                {`${which === "a" ? "起点" : "终点"} Y`}
                <input
                  type="number" min={0} max={size.height} step={1} value={line[which][1]} disabled={disabled}
                  onChange={(event) => edit(which, 1, Number(event.currentTarget.value))}
                />
              </label>
            </span>
          ))}
          <Button size="sm" tone="ghost" disabled={disabled} onClick={() => onChange(null)}>清除拉直线</Button>
        </div>
      )}
    </div>
  );
}

/**
 * 置换滤镜的位移图来源：只列会话里已打开的文档。
 *
 * 内核只接受 `mapPath`（本应用拒绝）或 `mapDocument`；这里把已打开文档列成选择器，用户
 * 选一份就写回 `mapDocument`，不出现「点了确认才报缺来源」的死路。
 */
function DisplaceMapPicker({ sources, value, missing, layer, disabled, onRefresh, onChange, onLayer }: {
  sources: FilterMapSource[];
  value: string;
  missing: string | null;
  layer: number | null;
  disabled: boolean;
  onRefresh: () => void;
  onChange: (source: string) => void;
  onLayer: (layer: number | null) => void;
}) {
  // 图层候选来自**选中的那份文档**：内核的 `mapLayer` 是文档内的图层 id，不是全局 id。
  const selected = sources.find((source) => source.name === value);
  const layers = selected?.layers ?? [];
  return (
    <div className="photo-editor__filter-map" data-filter-map={value || "none"} data-filter-map-layers={layers.length}>
      <label>
        位移图文档
        <select value={value} disabled={disabled || sources.length === 0} onChange={(event) => onChange(event.currentTarget.value)}>
          <option value="">{sources.length === 0 ? "没有其它已打开文档" : "请选择位移图文档"}</option>
          {sources.map((source) => (
            <option key={source.index} value={source.name}>
              {`${source.name}（${source.width}×${source.height}${source.active ? "，当前" : ""}）`}
            </option>
          ))}
        </select>
      </label>
      {/* 内核缺省压平整份文档；只取一层时结果不同，所以这里必须能选。 */}
      <label>
        位移图图层
        <select
          value={layer === null ? "" : String(layer)}
          disabled={disabled || !selected || layers.length === 0}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            onLayer(raw === "" ? null : Number(raw));
          }}
        >
          <option value="">{selected ? "整份文档（压平）" : "先选位移图文档"}</option>
          {layers.map((item) => (
            <option key={item.id} value={String(item.id)}>{item.name}</option>
          ))}
        </select>
      </label>
      {/* 新开一份文档不会重挂面板：给一个显式重读，免得用户以为来源列表卡住了。 */}
      <Button size="sm" tone="ghost" disabled={disabled} onClick={onRefresh}>刷新来源</Button>
      <span className="photo-editor__option-hint">位移图取自已打开的文档；本应用不读取本机路径。</span>
      {missing ? (
        <p className="photo-editor__brush-note photo-editor__brush-note--error">
          {`位移图「${missing}」已不在打开的文档里，请重新选择。`}
        </p>
      ) : null}
    </div>
  );
}
