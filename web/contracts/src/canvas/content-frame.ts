import type { ServerCanvas } from "./domain/types.js";
/**
 * 复合内容（片场）预览/历史帧的**host ↔ extension 端口**与场景帧协议
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主（canvas-service）只依赖这里的接口：预览帧、历史缩略图帧与"渲染期间定义是否变化"的判定
 * 都由持有片场领域的扩展实现。宿主不 import 任何扩展实现，也不在本包里放实现。
 *
 * 场景帧（`ContentSceneFrame`）是宿主与原生渲染器之间的协议载荷，扩展产出、宿主转发；
 * `service/canvas-service/src/model-renderer` 的 `RendererSceneRequest` 由它 + 请求/截图参数组成。
 */
import type { Aabb } from "./model-transform.js";
import type { BevyManagedItemMotion } from "./render-scene/wire-transient.js";
import type { BevyNativeMediaFrame } from "./render-scene.js";
import type { CanvasNodeData } from "./domain/types.js";
import type { FilmSetGroupHistoryPayload, FilmSetHistoryAnimationPayload } from "./node-history/types.js";
import type { StoredAsset } from "./domain/types.js";

/** 媒体读取端口：storageKey → 字节 + 内容类型；由宿主媒体服务实现，扩展不直接读盘。 */
/**
 * 稳定媒体字节读取。
 *
 * `canvasId` 可选：远端画布的字节只在托管存储里，调用方知道所属画布时必须带；
 * 省略表示与画布无关（保持旧行为）。
 */
export type ContentMediaReader = (storageKey: string, canvasId?: string, extensionId?: string) => Promise<{ bytes: Uint8Array; contentType: string }>;

/** 动画采样请求（渲染器协议的一部分）。 */
export type ContentMotionRequest = {
  duration: number;
  looped: boolean;
  cameraMotion: unknown[];
  modelMotion: unknown[];
  managedItemMotion?: BevyManagedItemMotion[];
  initialCamera: {
    azimuth: number;
    elevation: number;
    distance: number;
    focusOffset: [number, number, number];
    aspect: string;
  };
  timeSeconds: number;
};

/**
 * 场景帧：复合内容在某一时刻的可渲染快照（渲染器协议载荷，不含 requestId/capture）。
 *
 * `ops` 是版本化的场景 IR；`compositeAssetFrame` 携带复合资产的画布尺寸与原生媒体帧；
 * `motion` 是动画采样（仅复合资产节点）。
 */
export type ContentSceneFrame = {
  sceneVersion: string;
  signature: string;
  extent: number;
  ops: unknown[];
  compositeAssetFrame?: {
    width: number;
    height: number;
    resourceExtent: number;
    layoutAabb?: Aabb | null;
    media?: BevyNativeMediaFrame[];
  };
  /** 实例 placement（可选）。 */
  placement?: { offset: [number, number, number]; scale: number; yaw: number };
  /** 动画采样（可选；仅复合资产）。 */
  motion?: ContentMotionRequest;
};

/** 预览帧的动画元信息（随预览结果上报，不参与渲染）。 */
export type ContentAnimationMetadata = {
  /** 共享 items 内容身份。 */
  contentHash: string;
  /** 目标片段身份。 */
  clipHash: string;
  snapshotHash: string;
  timeSeconds: number;
  duration: number;
  loop: boolean;
  clipId?: string;
};

/** 预览帧准备结果。失败时带稳定错误码，宿主原样透出。 */
export type ContentPreviewFrame =
  | {
      ok: true;
      clipId?: string;
      sourceHash: string;
      animationIdentity: string;
      snapshotHash: string;
      metadata: { animation?: ContentAnimationMetadata };
      scene: ContentSceneFrame;
    }
  | { ok: false; code: string; message: string };

/** 历史缩略图帧：`identity` 用于判断同一历史定义是否已渲染过。 */
export type ContentHistoryFrame = ContentSceneFrame & { identity: string };

/**
 * 复合内容帧端口：由拥有该内容领域的扩展实现，宿主经 `CanvasServiceOptions` 注入。
 *
 * 宿主对它**无实现依赖**：未装配时预览回落为 `content-runtime-unavailable`，历史缩略图回落为
 * `composite-history-unavailable`。
 */
export type ContentFrameRuntime = {
  /** 该节点是否由本适配器负责（宿主据此选择预览/历史帧路径）。 */
  matches(nodeType: string, data: CanvasNodeData | undefined): boolean;
  /** 准备一张预览帧；`data` 为原始节点数据，由适配器自行解码/校验。 */
  preparePreviewFrame(input: {
    nodeId: string;
    node: { width?: number; height?: number };
    data: CanvasNodeData | undefined;
    canvas?: ServerCanvas;
    assets: readonly StoredAsset[];
    clipId?: string;
    timeSeconds: number;
    read?: ContentMediaReader;
  }): Promise<ContentPreviewFrame>;
  /** 准备历史缩略图帧：使用**保存的定义**而不是当前节点内容。 */
  prepareHistoryFrame(input: {
    nodeId: string;
    payload: FilmSetHistoryAnimationPayload | FilmSetGroupHistoryPayload;
    canvas?: ServerCanvas;
    assets: readonly StoredAsset[];
    read?: ContentMediaReader;
  }): ContentHistoryFrame | Promise<ContentHistoryFrame>;
  /** 渲染期间权威定义是否仍未变化（用于丢弃陈旧快照）。 */
  identityMatches(before: CanvasNodeData | undefined, after: CanvasNodeData | undefined, clipId?: string, beforeCanvas?: ServerCanvas, afterCanvas?: ServerCanvas): boolean;
};
