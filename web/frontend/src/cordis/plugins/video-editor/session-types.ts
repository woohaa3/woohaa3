/**
 * 视频聚焦会话（DOM 无关控制器）
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 2.1–2.3 / 4.x，design D2/D5）。
 *
 * 拥有一次视频聚焦会话：
 * - 一个**活动解码源**（隐藏 `<video>` 元素，非 hover 会话），负责真实帧 → Bevy 纹理上传；
 * - 本地二维取景（适应窗口/缩放/平移），与图片聚焦共用同一投影 wire 语义；
 * - 只读历史 override：切到旧版本受控媒体（同源 `/preview`），保存并恢复当前现场；
 * - generation 防护：换源/退出后的迟到 metadata/seek/frame 回调被丢弃；
 * - 退出释放媒体源、撤销回调、恢复 canonical 卡片纹理并由调用方恢复视口。
 *
 * 播放状态/currentTime/像素/取景只存在于本会话，不写 Y.Doc/nodeData/history。帧集合由 React
 * overlay 的共享截帧主体持有（工具区切换不卸载 overlay，故状态保留）。
 */
import { type ServerCanvas } from "@woohaa3/contracts";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import {
  type RasterCanvasFactory
} from "../canvas-runtime/media-raster.js";
import type { VideoElementLike } from "../canvas-runtime/video-frame-session.js";
import type { FocusContentRect } from "../../focus/types.js";
import { resolveVideoFocusTarget, type VideoFocusTarget } from "./targets.js";

/** 聚焦纹理最长边（高于卡片 1024，兼顾高 DPR 清晰度与上传成本）。 */
export const VIDEO_FOCUS_TEXTURE_MAX_DIMENSION = 2048;
/** 默认帧上传上限 ≈ 60fps。 */
export const VIDEO_FOCUS_MIN_UPLOAD_INTERVAL_MS = 1000 / 60;
/** 手动缩放区间（与图片聚焦一致的可用范围）。 */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 12;

export type VideoFocusViewport = { x: number; y: number; zoom: number };

export type VideoFocusSessionOptions = {
  nodeId: string;
  target: VideoFocusTarget;
  getCanvas: () => ServerCanvas | null;
  rect: FocusContentRect;
  createVideo?: () => VideoElementLike;
  createCanvas?: RasterCanvasFactory;
  runtime?: BevyRuntime | null;
  /** 推入/清除视频聚焦投影。 */
  setProjection: (projection: import("@woohaa3/contracts").BevyVideoFocus | null) => void;
  /** 推入/清除聚焦纹理。 */
  onTexture: (texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null) => void;
  /** 进入前本地视口（退出恢复）。 */
  savedViewport: { x: number; y: number; zoom: number };
  restoreViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  minUploadIntervalMs?: number;
  now?: () => number;
  /** 进入/退出聚焦的取景过渡时长（毫秒）；缺省尊重 `prefers-reduced-motion`。测试注入 0 关闭动画。 */
  transitionDuration?: number;
  /**
   * 公共取景过渡端口（Canvas Runtime scope 的 coordinator；design D6/D7）。
   * 缺省使用最小等价本地实现；feature MUST NOT 自带独立计时器。
   */
  transition?: import("../../focus/media-transition.js").FocusTransitionPort;
};

export type VideoFocusState = {
  nodeId: string;
  url: string;
  posterUrl: string | null;
  duration: number;
  currentTime: number;
  playing: boolean;
  muted: boolean;
  ready: boolean;
  width: number;
  height: number;
  viewport: VideoFocusViewport;
  /** history override（只读）活动来源；无则 null。 */
  historyUrl: string | null;
  loading: boolean;
  error: string | null;
};

/** 适应窗口缩放：1 源像素 = zoom CSS px。 */
export function fitZoomFor(sourceWidth: number, sourceHeight: number, rect: { width: number; height: number }): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || rect.width <= 0 || rect.height <= 0) return 1;
  return clampZoom(Math.min(rect.width / sourceWidth, rect.height / sourceHeight));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

export function defaultCreateVideo(): VideoElementLike {
  return document.createElement("video") as unknown as VideoElementLike;
}

/** 供测试/诊断：当前目标的稳定身份。 */
export function videoTargetIdentity(target: VideoFocusTarget): string {
  return `media:${typeof target.asset.metadata?.storageKey === "string" ? target.asset.metadata.storageKey : target.asset.id}`;
}

export { resolveVideoFocusTarget };
