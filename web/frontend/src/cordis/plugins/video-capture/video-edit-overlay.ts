/**
 * 视频标注覆盖层 canvas 绘制与播放器尺寸跟踪
 * （change: 2026-09-28-split-frontend-god-plugins，task 5.4；从 video-edit-dialog 拆出）。
 */
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { VideoEditAnnotationShape } from "@woohaa3/contracts";
import { drawShape } from "./video-edit-helpers.js";
import type { ContentRect } from "./video-geometry.js";

/** 把当前 shape 列表按内容矩形重绘到覆盖层 canvas，并随窗口 resize 重绘。 */
export function useOverlayCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  contentRect: ContentRect,
  shapes: readonly VideoEditAnnotationShape[]
) {
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    for (const shape of shapes) drawShape(context, shape, contentRect);
  }, [canvasRef, contentRect, shapes]);

  useEffect(() => {
    redraw();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [redraw]);
}

/** 跟踪播放器容器尺寸（供内容矩形换算）。 */
export function usePlayerSize(playerRef: RefObject<HTMLDivElement | null>) {
  const [playerSize, setPlayerSize] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const player = playerRef.current;
    if (!player || typeof ResizeObserver === "undefined") return undefined;
    const update = () => setPlayerSize({ width: player.clientWidth, height: player.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(player);
    return () => observer.disconnect();
  }, [playerRef]);
  return [playerSize, setPlayerSize] as const;
}
