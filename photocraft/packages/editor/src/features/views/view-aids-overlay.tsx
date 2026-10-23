import { documentToView, guideSegment, screenThreshold, type ViewTransformState } from "./view-transform.js";

export type CanvasAids = {
  rulers?: boolean;
  grid?: boolean;
  guides?: boolean;
  gridStep?: number[];
  /** 网格细分（1 = 不细分）；U71 的「网格细分」偏好。 */
  gridSubdivisions?: number;
  /** 标尺单位（`px` / `in` / …）；只影响刻度文字，不改变刻度密度。 */
  units?: string;
  /**
   * 取景旋转角（来自内核 `viewAids`）。
   *
   * 共享画布目前只传 `origin/zoom`，不会单独传 `rotation`；`aids` 里已经有这个值，
   * 叠加层从这里回退，旋转视图后参考线与网格才会跟着转。
   */
  rotation?: number;
  /** 文档标尺零点（来自内核 `viewAids`，与 `rotation` 同一来源）。 */
  rulerOrigin?: [number, number];
  /**
   * 同文档多视图（U72）：并排开关、活动视图与每个视图的取景记录。
   *
   * 画布用 `sideBySide`/`views` 决定渲染几块并各自绑定哪个视图；叠加层本身只用活动视图的
   * 旋转与零点，取景由应用映射成每块画布各自的视口。
   */
  sideBySide?: boolean;
  activeView?: string;
  views?: ReadonlyArray<{ id: string; label: string; zoom: number; offset: [number, number]; rotation: number; active: boolean }>;
};

/** 网格细分的合法范围：与内核 `ViewAids` 的校验保持一致。 */
export const MAX_GRID_SUBDIVISIONS = 16;

/**
 * 一个网格单元内的细分线偏移（源像素）。
 *
 * `subdivisions = 1` 时返回空数组（只有单元边界），4 时返回 1/4、2/4、3/4 三条。用源像素而不是屏幕
 * 像素，缩放后细分线仍按文档几何等分。
 */
export function gridSubdivisions(step: number, subdivisions: number | undefined): number[] {
  const parts = Math.trunc(subdivisions ?? 1);
  if (!Number.isFinite(step) || step <= 0) return [];
  if (parts < 2 || parts > MAX_GRID_SUBDIVISIONS) return [];
  return Array.from({ length: parts - 1 }, (_, index) => ((index + 1) * step) / parts);
}

/** 标尺刻度在**屏幕**上至少相隔的像素数；越小越密。 */
const MIN_TICK_GAP_PX = 60;

/**
 * 标尺刻度值（源像素，从 `1/2/5 × 10ⁿ` 里挑一个屏幕间距不小于 [`MIN_TICK_GAP_PX`] 的步长）。
 *
 * `origin` 是标尺零点（文档坐标）：刻度从原点向两侧排，所以 `0` 一定落在原点上，而不是永远落在
 * 文档左上角（U70 的「原点拖动」必须让标尺读数跟着走）。
 */
export function rulerTicks(length: number, zoom: number, origin = 0): number[] {
  if (!Number.isFinite(length) || !Number.isFinite(zoom) || zoom <= 0 || length <= 0) return [];
  const raw = MIN_TICK_GAP_PX / zoom;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((value) => value >= raw) ?? 10 * magnitude;
  const first = Math.ceil((0 - origin) / step) * step;
  const values: number[] = [];
  for (let value = first; value + origin <= length && values.length < 1000; value += step) {
    // 去掉浮点累加的 1e-13 级噪声，避免刻度文字出现 `29.999999999`。
    values.push(Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(6)));
  }
  return values;
}

/** 刻度文字：有单位换算回调就用它，否则按源像素取整显示。 */
function tickText(value: number, describe?: (px: number) => string): string {
  return describe ? describe(value) : String(Math.round(value));
}

/**
 * 画布视图辅助叠加层（标尺、网格、参考线）。
 *
 * 所有几何都在**源像素**里算，再经本域唯一变换 [`documentToView`] 投影到视口；旋转后参考线不再是
 * 水平/垂直线段，因此这里逐条画两端点，而不是给图片加 CSS 旋转。
 *
 * 可选 props 都有保守默认值，共享画布只传 `origin/zoom` 时行为与之前一致：
 * - `rotation`：取景旋转角（默认 0°，等价于未启用旋转取景）；
 * - `rulerOrigin`：文档里的标尺零点（默认 `[0, 0]`，即文档左上角）；
 * - `formatLength`：单位换算由内核 `formatLengthJson` 提供，叠加层不自己发明单位规则。
 */
/** 两条标尺交汇的角落尺寸（与上面两个 `<rect>` 一致），留给标尺原点拖动。 */
const RULER_CORNER: readonly [number, number] = [24, 20];

export function ViewAidsOverlay({
  aids,
  guides,
  origin,
  zoom,
  width,
  height,
  rotation: rotationProp,
  rulerOrigin: rulerOriginProp,
  formatLength,
  onRulerDown,
}: {
  aids: CanvasAids;
  guides: { horizontal?: number[]; vertical?: number[] };
  origin: { x: number; y: number };
  zoom: number;
  width: number;
  height: number;
  rotation?: number;
  rulerOrigin?: [number, number];
  formatLength?: (px: number) => string;
  /**
   * 从标尺条按下时新建参考线（U70）。
   *
   * 返回 `true` 表示这次按下已被接管：调用方负责后续移动/提交（与画布的
   * `onGuideDown` 同一套会话），覆盖层只负责把「按在哪个标尺上」变成一次意图。
   * 未提供时标尺条保持纯展示（`pointer-events: none`）。
   */
  onRulerDown?: (vertical: boolean, pointerId: number) => boolean;
}) {
  // 显式 prop 优先；共享画布没传时退回 `aids` 里的同源字段（内核 `viewAids` 一并给出），
  // 这样旋转/拖动原点不需要再改冻结的画布文件就能画对。
  const rotation = Number.isFinite(rotationProp) ? (rotationProp as number) : (aids.rotation ?? 0);
  const rulerOrigin: [number, number] = Array.isArray(rulerOriginProp)
    ? rulerOriginProp
    : aids.rulerOrigin ?? [0, 0];
  const document: [number, number] = [width, height];
  const transform: ViewTransformState = { zoom, offset: [origin.x, origin.y], rotation };
  const describe = formatLength;
  const step = aids.gridStep ?? [18, 18];
  const projected = documentToView([0, 0], transform, document);
  const gridSize: [number, number] = [
    Math.max(2, (step[0] ?? 18) * zoom),
    Math.max(2, (step[1] ?? 18) * zoom),
  ];
  const subdivisionsX = gridSubdivisions(step[0] ?? 18, aids.gridSubdivisions).map((offset) => offset * zoom);
  const subdivisionsY = gridSubdivisions(step[1] ?? 18, aids.gridSubdivisions).map((offset) => offset * zoom);
  const threshold = screenThreshold(6, zoom);
  const xTicks = rulerTicks(width, zoom, rulerOrigin[0]);
  const yTicks = rulerTicks(height, zoom, rulerOrigin[1]);
  return <svg className="photo-editor__view-aids" data-view-aids-overlay="true" data-rotation={rotation}>
    {aids.grid ? <>
      <defs>
        <pattern id="photocraft-grid" width={gridSize[0]} height={gridSize[1]} patternUnits="userSpaceOnUse"
          x={projected[0]} y={projected[1]} patternTransform={rotation ? `rotate(${rotation} ${projected[0]} ${projected[1]})` : undefined}>
          <path d={`M${gridSize[0]} 0H0V${gridSize[1]}`} fill="none" stroke="var(--app-web-text-muted)" strokeOpacity=".45" strokeWidth=".5" />
          {/* 细分线更淡：只做对位参考，不喧宾夺主盖过主网格。 */}
          <path
            d={[
              ...subdivisionsX.map((x) => `M${x} 0V${gridSize[1]}`),
              ...subdivisionsY.map((y) => `M0 ${y}H${gridSize[0]}`),
            ].join("")}
            fill="none" stroke="var(--app-web-text-muted)" strokeOpacity=".22" strokeWidth=".5"
            data-grid-subdivisions={aids.gridSubdivisions ?? 1} />
        </pattern>
      </defs>
      <rect x={projected[0]} y={projected[1]} width={width * zoom} height={height * zoom} fill="url(#photocraft-grid)" />
    </> : null}
    {aids.guides !== false ? <g stroke="var(--app-interaction-accent)" strokeWidth="1" data-guide-hit-threshold={threshold}>
      {(guides.vertical ?? []).map((position, index) => {
        const [a, b] = guideSegment(true, position, transform, document);
        return <line key={`v${index}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} data-guide={`vertical-${index}`} />;
      })}
      {(guides.horizontal ?? []).map((position, index) => {
        const [a, b] = guideSegment(false, position, transform, document);
        return <line key={`h${index}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} data-guide={`horizontal-${index}`} />;
      })}
    </g> : null}
    {aids.rulers ? <g className="photo-editor__rulers" data-rulers="true" data-ruler-origin={rulerOrigin.join(",")}>
      {/* 上边标尺拖出竖线，左边标尺拖出横线；没有接管方时保持 pointer-events: none。
          标尺角落（24×20）留给原点拖动，不新建参考线。 */}
      <rect width="100%" height="20" data-ruler-strip="horizontal" style={onRulerDown ? { pointerEvents: "auto", cursor: "col-resize" } : undefined}
        onPointerDown={onRulerDown ? event => {
          // 角落用**元素自身**的包围盒判断，不能用视口坐标：画布容器通常不在 (0,0)。
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX - box.left < RULER_CORNER[0]) return;
          // 标尺条在画布容器**之内**（`renderOverlay` 的产物），事件会冒泡到画布的
          // `onPointerDown`。这里必须无条件拦住：标尺不是文档区域，点在哪儿都不该落笔；
          // 而且锁定时 `onRulerDown` 返回 false，若只在成功时拦，就会漏成一次绘画。
          event.stopPropagation();
          onRulerDown(true, event.pointerId);
        } : undefined} />
      <rect width="24" height="100%" data-ruler-strip="vertical" style={onRulerDown ? { pointerEvents: "auto", cursor: "row-resize" } : undefined}
        onPointerDown={onRulerDown ? event => {
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientY - box.top < RULER_CORNER[1]) return;
          event.stopPropagation();
          onRulerDown(false, event.pointerId);
        } : undefined} />
      {/* 刻度从标尺零点开始排：拖动原点后 0 跟着走，读数才和 Info 面板一致。 */}
      {xTicks.map(value => <g key={`x${value}`} transform={`translate(${projected[0] + (value + rulerOrigin[0]) * zoom} 0)`}>
        <path d="M0 14V20" /><text x="3" y="11">{tickText(value, describe)}</text>
      </g>)}
      {yTicks.map(value => <g key={`y${value}`} transform={`translate(0 ${projected[1] + (value + rulerOrigin[1]) * zoom})`}>
        <path d="M18 0H24" /><text x="2" y="-3">{tickText(value, describe)}</text>
      </g>)}
    </g> : null}
  </svg>;
}
