/**
 * 画布视口缩放条（概览区竖向栏 / 收起条横排）
 * （参考 旧版画布 的缩放 popover；change: unify-canvas-corner-controls；
 *  change: adopt-radix-lucide-canvas-ui 任务 3.1：迁移到 IconButton/Tooltip 与 Lucide facade；
 *  2026-10-26：展开态为小地图右侧的窄竖向条；收起态在工具行上方横排）
 *
 * 展开态竖排：百分比 / 放大 / 竖向滑杆 / 缩小，步进按钮上下叠放以保持 32px 窄宽度；
 * 收起态横排通过 CSS order 还原「缩小 · 滑杆 · 百分比 · 放大」。
 * 纯展示层：所有操作经 `InteractionController` 提交本地视口。
 *
 * 百分比跟随本地视口刷新（change: fix-viewport-zoom-range）：捏合/滚轮/平移不推进
 * 画布 revision，因此不能只在 `revision` 变化时重读，需订阅视口变化。
 */
import { useEffect, useState } from "react";
import type { InteractionController } from "./interaction-controller.js";
import { IconButton } from "../../../shared/ui/Button.js";
import { Tooltip } from "../../../shared/ui/Tooltip.js";
import { ZoomInIcon, ZoomOutIcon } from "../../../shared/ui/icons.js";

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

  useEffect(() => {
    const controller = props.getController();
    if (!controller) return undefined;
    setZoom(controller.viewport().zoom);
    // 订阅本地视口变化：捏合/滚轮/平移不推进画布 revision，只有订阅才能让百分比跟进。
    return controller.subscribeViewport(() => setZoom(controller.viewport().zoom));
  }, [props.getController, props.revision]);

  const step = (factor: number) => {
    const controller = props.getController();
    controller?.zoomBy(factor);
    setZoom(controller?.viewport().zoom ?? zoom);
  };

  return (
    <div className="canvas-zoom" role="group" aria-label="画布缩放">
      <output className="canvas-zoom__value">{Math.round(zoom * 100)}%</output>
      <Tooltip content="放大">
        <IconButton
          className="canvas-zoom__step canvas-zoom__step--in"
          label="放大"
          size="sm"
          onClick={() => step(1.2)}
        >
          <ZoomInIcon size={14} />
        </IconButton>
      </Tooltip>
      <div className="canvas-zoom__slider-track">
        <input
          className="canvas-zoom__slider"
          type="range"
          min={ZOOM_SLIDER_MIN_PERCENT}
          max={ZOOM_SLIDER_MAX_PERCENT}
          step={1}
          value={Math.min(ZOOM_SLIDER_MAX_PERCENT, Math.round(zoom * 100))}
          aria-label="缩放"
          onChange={(event) => {
            const controller = props.getController();
            controller?.zoomTo(Number(event.target.value) / 100);
            setZoom(controller?.viewport().zoom ?? zoom);
          }}
        />
      </div>
      <Tooltip content="缩小">
        <IconButton
          className="canvas-zoom__step canvas-zoom__step--out"
          label="缩小"
          size="sm"
          onClick={() => step(1 / 1.2)}
        >
          <ZoomOutIcon size={14} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
