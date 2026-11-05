/**
 * 右下角工具栏的小地图（2026-10-26）。
 *
 * 微缩显示 working 画布的全部可见节点与连线，并叠加当前视口框；点击或拖动小地图把
 * 对应世界位置移到画布中心（保持缩放）。3D 内容节点用等距小方块（积木）缩略图表示，
 * 不申请真实模型预览资源，避免小地图成为第二套 residency 消费者。
 *
 * 概览区的显隐、两侧内容（如缩放条）由宿主 `CanvasToolbarHost` 负责；本组件只画地图本身。
 * 纯展示 + 指针转发：节点几何来自 `minimap-projection.ts`，视口读写仍归唯一
 * `InteractionController`；本组件不提交画布命令、不改 selection。
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { IconButton } from "@woohaa3/ui/primitives";
import { Tooltip } from "@woohaa3/ui/primitives";
import { CollapseIcon, FitScreenIcon } from "@woohaa3/ui/icons";
import {
  fitMinimapTransform,
  minimapPoint,
  minimapPointToWorld,
  minimapRect,
  projectMinimap,
  viewportCenteredOn,
  viewportWorldRect,
  type MinimapNode,
  type MinimapSurface,
  type MinimapTransform,
  type MinimapViewport
} from "./minimap-projection.js";
import type { InteractionController } from "./interaction-controller.js";

/** 小地图内部坐标尺寸（SVG viewBox）；屏幕尺寸由控件面板列宽决定。 */
const MINIMAP_WIDTH = 216;
const MINIMAP_HEIGHT = 136;
const MINIMAP_PADDING = 8;

export type CanvasMinimapProps = {
  getController: () => InteractionController | null;
  /** 当前画布 revision；页面或路由变化后重新绑定控制器。 */
  revision: number;
  /** 收起概览区；由宿主注入并保存展开状态。 */
  onCollapse?: () => void;
};

export function CanvasMinimap({ getController, revision, onCollapse }: CanvasMinimapProps) {
  const canvas = useSyncExternalStore(
    woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()),
    () => null
  );
  const selection = useSyncExternalStore(
    nodeSelectionStore.subscribe,
    nodeSelectionStore.getSnapshot,
    nodeSelectionStore.getSnapshot
  );
  const controllerRef = useRef<InteractionController | null>(null);
  const [viewport, setViewport] = useState<MinimapViewport | null>(null);
  const [surface, setSurface] = useState<MinimapSurface | null>(null);
  const dragPointer = useRef<number | null>(null);
  const gridId = `canvas-minimap-grid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    const controller = getController();
    controllerRef.current = controller;
    if (!controller) {
      setViewport(null);
      setSurface(null);
      return undefined;
    }
    const sync = () => {
      const view = controller.viewport();
      setViewport((previous) => previous
        && previous.x === view.x && previous.y === view.y && previous.zoom === view.zoom
        ? previous : view);
      const next = controller.surface();
      setSurface((previous) => previous
        && previous.width === next.width
        && previous.height === next.height
        ? previous
        : { width: next.width, height: next.height });
    };
    sync();
    const unsubscribe = controller.subscribeViewport(sync);
    // 窗口尺寸改变可见世界范围；视口本身不一定变化，因此单独跟一次。
    const onResize = () => sync();
    globalThis.window?.addEventListener?.("resize", onResize);
    return () => {
      unsubscribe();
      globalThis.window?.removeEventListener?.("resize", onResize);
    };
  }, [getController, revision]);

  const projection = useMemo(() => projectMinimap(canvas), [canvas]);
  const viewportRect = useMemo(() => viewportWorldRect(viewport, surface), [viewport, surface]);
  // With content, the fitted map depends on content bounds, not the viewport.
  // Keep its identity when the numeric mapping is unchanged so wheel events only
  // update the viewport rectangle, without recreating all node/edge elements.
  const { scale, offsetX, offsetY } = fitMinimapTransform(
    projection.bounds, viewportRect, MINIMAP_WIDTH, MINIMAP_HEIGHT, MINIMAP_PADDING
  );
  const transform = useMemo(() => ({ scale, offsetX, offsetY }), [scale, offsetX, offsetY]);
  const selectedIds = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds]);
  const nodeShapes = useMemo(
    () => projection.nodes.map((node) => (
      <MinimapNodeShape
        key={node.id}
        node={node}
        transform={transform}
        selected={selectedIds.has(node.id)}
      />
    )),
    [projection.nodes, selectedIds, transform]
  );
  const edgeShapes = useMemo(
    () => projection.edges.map((edge) => {
      const from = minimapPoint(edge.from, transform);
      const to = minimapPoint(edge.to, transform);
      return (
        <line
          key={edge.id}
          className="canvas-minimap__edge"
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
        />
      );
    }),
    [projection.edges, transform]
  );
  const viewportShape = viewportRect ? minimapRect(viewportRect, transform) : null;

  const centerOnPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const point = minimapPointToWorld({
      x: (event.clientX - bounds.left) / bounds.width * MINIMAP_WIDTH,
      y: (event.clientY - bounds.top) / bounds.height * MINIMAP_HEIGHT
    }, transform);
    const size = controller.surface();
    if (!(size.width > 0) || !(size.height > 0)) return;
    controller.restoreViewport(viewportCenteredOn(point, controller.viewport(), {
      width: size.width,
      height: size.height
    }));
    setViewport(controller.viewport());
  };

  return (
    <div className="canvas-minimap">
      <div className="canvas-minimap__frame">
        <svg
          className="canvas-minimap__svg"
          width={MINIMAP_WIDTH}
          height={MINIMAP_HEIGHT}
          viewBox={`0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}`}
          role="group"
          aria-label="画布小地图"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragPointer.current = event.pointerId;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            centerOnPointer(event);
          }}
          onPointerMove={(event) => {
            if (dragPointer.current !== event.pointerId) return;
            event.preventDefault();
            centerOnPointer(event);
          }}
          onPointerUp={(event) => {
            if (dragPointer.current !== event.pointerId) return;
            dragPointer.current = null;
            try {
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            } catch {
              // 指针可能已经释放。
            }
          }}
          onPointerCancel={() => { dragPointer.current = null; }}
        >
          <defs>
            <pattern id={gridId} width="12" height="12" patternUnits="userSpaceOnUse">
              <path className="canvas-minimap__grid-line" d="M 12 0 L 0 0 0 12" fill="none" />
            </pattern>
          </defs>
          <rect className="canvas-minimap__grid" width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} fill={`url(#${gridId})`} />
          {edgeShapes}
          {nodeShapes}
          {viewportShape && projection.nodes.length > 0 ? (
            <rect
              className="canvas-minimap__viewport-rect"
              x={viewportShape.x}
              y={viewportShape.y}
              width={Math.max(0, viewportShape.width)}
              height={Math.max(0, viewportShape.height)}
              rx={2}
            />
          ) : null}
          {projection.nodes.length === 0 ? (
            <text className="canvas-minimap__empty" x={MINIMAP_WIDTH / 2} y={MINIMAP_HEIGHT / 2} textAnchor="middle">
              画布还没有节点
            </text>
          ) : null}
        </svg>
        {onCollapse ? (
          <Tooltip content="收起小地图">
            <IconButton
              className="canvas-minimap__edge canvas-minimap__collapse"
              label="收起小地图"
              size="sm"
              onClick={() => onCollapse()}
            >
              <CollapseIcon size={14} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content="适合屏幕">
          <IconButton
            className="canvas-minimap__edge canvas-minimap__fit"
            label="适合屏幕"
            size="sm"
            onClick={() => controllerRef.current?.zoomToFit()}
          >
            <FitScreenIcon size={14} />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  );
}

/** 单个节点的缩略图形：普通节点是类型色圆角块，3D 内容节点是等距小方块。 */
function MinimapNodeShape({
  node,
  transform,
  selected
}: {
  node: MinimapNode;
  transform: MinimapTransform;
  selected: boolean;
}) {
  const rect = minimapRect(node.rect, transform);
  const title = node.title;
  if (node.model) {
    const size = Math.max(4, Math.min(16, Math.min(rect.width, rect.height) * 0.9));
    const half = size / 2;
    const quarter = size / 4;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return (
      <g className="canvas-minimap__node canvas-minimap__node--model" data-selected={selected ? "true" : undefined}>
        <title>{title}</title>
        <rect
          className="canvas-minimap__model-plate"
          x={rect.x}
          y={rect.y}
          width={Math.max(1, rect.width)}
          height={Math.max(1, rect.height)}
          rx={1.5}
        />
        <polygon
          className="canvas-minimap__block-top"
          points={`${cx},${cy - half} ${cx + half},${cy - quarter} ${cx},${cy} ${cx - half},${cy - quarter}`}
        />
        <polygon
          className="canvas-minimap__block-left"
          points={`${cx - half},${cy - quarter} ${cx},${cy} ${cx},${cy + half} ${cx - half},${cy + quarter}`}
        />
        <polygon
          className="canvas-minimap__block-right"
          points={`${cx},${cy} ${cx + half},${cy - quarter} ${cx + half},${cy + quarter} ${cx},${cy + half}`}
        />
      </g>
    );
  }
  return (
    <rect
      className="canvas-minimap__node"
      data-kind={node.kind}
      data-selected={selected ? "true" : undefined}
      x={rect.x}
      y={rect.y}
      width={Math.max(1, rect.width)}
      height={Math.max(1, rect.height)}
      rx={Math.min(3, Math.max(0.75, Math.min(rect.width, rect.height) / 3))}
    >
      <title>{title}</title>
    </rect>
  );
}
