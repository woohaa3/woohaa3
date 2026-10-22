/**
 * 画布视口缩放控件（紧凑版）
 * （参考 旧版画布 的缩放 popover；change: unify-canvas-corner-controls；
 *  change: adopt-radix-lucide-canvas-ui 任务 3.1：迁移到 IconButton/Tooltip 与 Lucide facade）。
 *
 * 放在右下角统一控件面板内：缩小 / 紧凑滑杆 / 百分比 / 放大 / 适合屏幕（图标）。
 * 纯展示层：所有操作经 `InteractionController` 提交本地视口。
 *
 * 百分比跟随本地视口刷新（change: fix-viewport-zoom-range）：捏合/滚轮/平移不推进
 * 画布 revision，因此不能只在 `revision` 变化时重读，需订阅视口变化。
 */
import { useEffect, useRef, useState } from "react";
import type { InteractionController } from "./interaction-controller.js";
import { IconButton } from "../../../shared/ui/Button.js";
import { Tooltip } from "../../../shared/ui/Tooltip.js";
import { FitScreenIcon, ZoomInIcon, ZoomOutIcon } from "../../../shared/ui/icons.js";

/** 滑杆上限（%），与 contracts 的 `WOOHAA3_CANVAS_MAX_ZOOM`（12 倍）一致。 */
const ZOOM_SLIDER_MAX_PERCENT = 1200;
/** 滑杆下限（%），与 contracts 的 `WOOHAA3_CANVAS_MIN_ZOOM`（0.1 倍）一致。 */
const ZOOM_SLIDER_MIN_PERCENT = 10;

export type CanvasZoomControlsProps = {
  getController: () => InteractionController | null;
  /** 当前画布 revision（宿主 slot 入参；百分比刷新由内部订阅视口驱动）。 */
  revision: number;
};

export function CanvasZoomControls(props: CanvasZoomControlsProps) {
  const [zoom, setZoom] = useState(1);
  const controllerRef = useRef<InteractionController | null>(null);

  // 读取当前本地缩放；手势与按钮都只改本地视口。
  const read = (): number => controllerRef.current?.viewport().zoom ?? zoom;

  useEffect(() => {
    const controller = props.getController();
    controllerRef.current = controller;
    if (!controller) return undefined;
    setZoom(controller.viewport().zoom);
    // 订阅本地视口变化：捏合/滚轮/平移不推进画布 revision，只有订阅才能让百分比跟进。
    return controller.subscribeViewport(() => setZoom(controller.viewport().zoom));
  }, [props.getController, props.revision]);

  return (
    <div className="canvas-zoom" role="group" aria-label="画布缩放">
      <Tooltip content="缩小">
        <IconButton
          className="canvas-control-panel__icon"
          label="缩小"
          onClick={() => {
            props.getController()?.zoomBy(1 / 1.2);
            setZoom(read());
          }}
        >
          <ZoomOutIcon className="canvas-control-panel__icon-svg" />
        </IconButton>
      </Tooltip>
      <input
        className="canvas-zoom__slider"
        type="range"
        min={ZOOM_SLIDER_MIN_PERCENT}
        max={ZOOM_SLIDER_MAX_PERCENT}
        step={1}
        value={Math.min(ZOOM_SLIDER_MAX_PERCENT, Math.round(zoom * 100))}
        aria-label="缩放"
        onChange={(event) => {
          props.getController()?.zoomTo(Number(event.target.value) / 100);
          setZoom(read());
        }}
      />
      <output className="canvas-zoom__value">{Math.round(zoom * 100)}%</output>
      <Tooltip content="放大">
        <IconButton
          className="canvas-control-panel__icon"
          label="放大"
          onClick={() => {
            props.getController()?.zoomBy(1.2);
            setZoom(read());
          }}
        >
          <ZoomInIcon className="canvas-control-panel__icon-svg" />
        </IconButton>
      </Tooltip>
      <Tooltip content="适合屏幕">
        <IconButton
          className="canvas-control-panel__icon"
          label="适合屏幕"
          onClick={() => {
            props.getController()?.zoomToFit();
            setZoom(read());
          }}
        >
          <FitScreenIcon className="canvas-control-panel__icon-svg" />
        </IconButton>
      </Tooltip>
    </div>
  );
}
