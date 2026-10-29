/**
 * 拍摄镜头预览的宿主 scene 输入派生
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D7/D8）。
 *
 * 渲染层只消费**只读派生**，因此这里把两件事投影成 `buildCanvasRenderScene` 的输入：
 *
 * 1. `shotPreviews`：每张预览卡片的本地状态与播放进度。进度/播放只承载浏览器本地播放投影，
 *    不是 canonical；失败状态来自共享动作校验门禁（不伪造画布/GPU 就绪）。
 * 2. `shotPreviewCameraProjection`：归属线的画布 2D 起点。片场 group 固定取**徽标中心**
 *    （徽标即场景入口，与 Bevy 绘制同一几何派生）；只有没有外部徽标的复合资产片场才把镜头
 *    当前相机世界姿态投影为起点——静态与非活动动态镜头用 `initialCamera`，活动动态镜头用
 *    **同一 T** 的采样相机（与 Rust `AnimationCameraState` 同一公式）。
 *
 * 本模块纯函数、无副作用：不写 ServerCanvas / CanvasCommand / Y.Doc，也不创建第二份权威数据。
 */
import {
  checkAnimationMotion,
  getGroupLayoutSizes,
  getWoohaa3CanvasNodeAbsolutePosition,
  groupBadgeRect,
  managedShotPreviewOwnershipOf,
  readFilmSetAnimationProjection,
  evaluateMotionIr,
  MOTION_IR_VERSION,
  resolveAnimationGate,
  resolveFilmSetClip,
  shotCameraPosition,
  shotPreviewOwnershipOf,
  worldToCanvasPoint,
  type BevyAnimationPlayback,
  type FilmSetNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";
import { modelBounds, type FocusTargetInput } from "./model-focus-session.js";

/** 单张预览卡片的本地呈现输入（render scene `shotPreviews` 条目）。 */
export type ShotPreviewLocalState = {
  state: "preparing" | "ready" | "stale" | "error";
  progress?: number;
  playing?: boolean;
  diagnostic?: string;
};

/** 宿主注入的拍摄镜头 scene 输入。 */
export type ShotPreviewSceneInput = {
  /** 预览节点 id → 本地状态；缺省即 `ready` 且无播放进度。 */
  shotPreviews: ReadonlyMap<string, ShotPreviewLocalState>;
  /**
   * 归属线起点投影：把镜头当前相机世界姿态投影为画布 2D 点；缺失返回 `null`（不伪造起点）。
   */
  shotPreviewCameraProjection: (filmSetNodeId: string, clipId: string) => { x: number; y: number } | null;
};

export type ShotPreviewSceneInputSource = {
  /** 当前绘制画布（working projection 优先；与实际渲染同源）。 */
  canvas: ServerCanvas | null;
  /** 当前活动播放投影（无活动会话为 null）。 */
  playback: BevyAnimationPlayback | null;
  /** 已解析的模型聚焦目标集合（片场世界包围球的共享事实源）。 */
  targets: readonly FocusTargetInput[];
  /**
   * 正在拖动中的徽标倍率预览（只覆盖对应 group）。归属线起点必须跟着预览走，
   * 否则拖动时徽标中心已经移动、线头却停在上一次提交的位置。
   */
  badgeScaleOverrides?: ReadonlyMap<string, number>;
};

/**
 * 归属线起点。
 *
 * 片场 group 固定从**徽标中心**（场景入口）出发：镜头相机悬在场景上方，它的世界姿态
 * 投影落在徽标外面（徽标上方的组气泡里），画出来就像「从组气泡中间随便拉一条线」。
 * 只有没有外部徽标的复合资产片场才退回相机姿态投影。
 */
export function shotPreviewLinkOrigin(
  badge: { center: { x: number; y: number } } | null,
  cameraProjection: { x: number; y: number } | null
): { x: number; y: number } | null {
  if (badge) return { x: badge.center.x, y: badge.center.y };
  return cameraProjection;
}

/** 由权威画布 + 播放投影派生宿主 scene 输入（纯函数）。 */
export function buildShotPreviewSceneInput(source: ShotPreviewSceneInputSource): ShotPreviewSceneInput {
  const canvas = source.canvas;
  if (!canvas) {
    return { shotPreviews: new Map(), shotPreviewCameraProjection: () => null };
  }
  const playback = source.playback;
  const targets = new Map(source.targets.map((target) => [target.nodeId, target]));
  // 每片场只解析一次包围球（同一帧多张卡片/多条线复用）。
  const boundsCache = new Map<string, ReturnType<typeof modelBounds>>();
  const boundsOf = (filmSetNodeId: string): ReturnType<typeof modelBounds> => {
    if (boundsCache.has(filmSetNodeId)) return boundsCache.get(filmSetNodeId) ?? null;
    const target = targets.get(filmSetNodeId);
    const bounds = target ? modelBounds(target) : null;
    boundsCache.set(filmSetNodeId, bounds);
    return bounds;
  };
  const nodeData = canvas.nodeData as Record<string, unknown>;
  const filmSetData = (nodeId: string): FilmSetNodeData | null => {
    return readFilmSetAnimationProjection(canvas, nodeId);
  };

  const shotPreviews = new Map<string, ShotPreviewLocalState>();
  for (const node of canvas.document.nodes) {
    // 旧形态读 `shotPreview`；迁移后的预览改成 group 拥有的 owner-managed 媒体节点。
    const ownership = shotPreviewOwnershipOf(nodeData[node.id]) ?? managedShotPreviewOwnershipOf(nodeData[node.id]);
    if (!ownership) continue;
    const data = filmSetData(ownership.filmSetNodeId);
    if (!data) continue;
    const resolved = resolveFilmSetClip(data, ownership.clipId);
    if (!resolved) continue;
    // 失败状态来自共享动作校验门禁：脚本/绑定不可预览时明确报出原因，保留归属。
    const gate = resolveAnimationGate(checkAnimationMotion(resolved));
    const local: ShotPreviewLocalState = gate.canPreview
      ? { state: "ready" }
      : { state: "error", ...(gate.reason ? { diagnostic: gate.reason } : {}) };
    // 活动动态卡片承载本地播放进度（不进入 canonical）；命中身份须同时匹配片场/镜头/卡片。
    if (
      playback &&
      playback.viewMode === "shot-node-preview" &&
      playback.nodeId === ownership.filmSetNodeId &&
      playback.clipId === ownership.clipId &&
      playback.targetPreviewNodeId === node.id &&
      resolved.clip.kind === "dynamic"
    ) {
      const duration = resolved.timeline.duration;
      if (duration > 0) local.progress = Math.min(1, Math.max(0, playback.time / duration));
      local.playing = playback.playing;
    }
    shotPreviews.set(node.id, local);
  }

  /**
   * 片场 3D 徽标在画布坐标系里的矩形。
   *
   * 与 Bevy 绘制同源：徽标画在**成员布局矩形**（`getGroupLayoutSizes`）下缘 6px，再按
   * `groupBadgeScale` 保持气泡中线对齐等比放大。用节点自身尺寸推导会让徽标整体高出一整段。
   */
  const badgeRectOf = (filmSetNodeId: string): { x: number; y: number; width: number; height: number; center: { x: number; y: number } } | null => {
    const node = canvas.document.nodes.find((entry) => entry.id === filmSetNodeId);
    if (!node || node.type !== "group") return null;
    const world = getWoohaa3CanvasNodeAbsolutePosition(node, new Map(canvas.document.nodes.map((entry) => [entry.id, entry])));
    const data = nodeData[filmSetNodeId] as { groupBadgeScale?: number; groupCollapsed?: boolean } | undefined;
    const layout = getGroupLayoutSizes(canvas.document.nodes).get(filmSetNodeId);
    const rect = {
      x: world.x,
      y: world.y,
      width: layout?.width ?? node.width ?? 180,
      height: layout?.height ?? node.height ?? 112
    };
    const scale = source.badgeScaleOverrides?.get(filmSetNodeId) ?? data?.groupBadgeScale;
    return groupBadgeRect(rect, scale);
  };

  const shotPreviewCameraProjection = (filmSetNodeId: string, clipId: string): { x: number; y: number } | null => {
    const data = filmSetData(filmSetNodeId);
    if (!data) return null;
    const resolved = resolveFilmSetClip(data, clipId);
    if (!resolved) return null;
    // 片场 group 的归属线固定从徽标中心（场景入口）出发，不跟随相机姿态；
    // 相机悬在场景上方时其投影会落在徽标外的组气泡里，看着像随机点。
    const badge = badgeRectOf(filmSetNodeId);
    if (badge) return shotPreviewLinkOrigin(badge, null);
    const bounds = boundsOf(filmSetNodeId);
    if (!bounds) return null;
    const live = playback
      ? playback.viewMode === "shot-node-preview" &&
        playback.nodeId === filmSetNodeId &&
        playback.clipId === clipId
      : false;
    const camera = live && playback ? sampledCamera(playback) ?? resolved.initialCamera : resolved.initialCamera;
    const focus: [number, number, number] = [
      bounds.center[0] + camera.focusOffset.x,
      bounds.center[1] + camera.focusOffset.y,
      bounds.center[2] + camera.focusOffset.z
    ];
    const position = shotCameraPosition(focus, camera.azimuth, camera.distance, camera.elevation);
    if (!position.every((value) => Number.isFinite(value))) return null;
    const projected = worldToCanvasPoint(position);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
    return shotPreviewLinkOrigin(null, { x: projected.x, y: projected.y });
  };

  return { shotPreviews, shotPreviewCameraProjection };
}

/**
 * 活动动态镜头的**同一 T** 采样相机。
 *
 * 复用共享 `evaluateMotionIr`（与 Rust `AnimationCameraState` 同一 IR 与求值规则），因此卡片
 * 线起点、Rust 相机标记与预览画面使用同一时刻姿态；求值失败时回退镜头初始构图（不伪造）。
 */
function sampledCamera(playback: BevyAnimationPlayback): {
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: { x: number; y: number; z: number };
} | null {
  const camera = playback.initialCamera;
  const evaluated = evaluateMotionIr(
    { version: MOTION_IR_VERSION, cameraMotion: playback.cameraMotion ?? [], modelMotion: [] },
    playback.time,
    {
      duration: playback.duration,
      initialCamera: {
        azimuth: camera.azimuth,
        elevation: camera.elevation,
        distance: camera.distance,
        focusOffset: { x: camera.focusOffset[0], y: camera.focusOffset[1], z: camera.focusOffset[2] }
      },
      partIds: new Set<string>()
    }
  );
  if (!evaluated.ok) return null;
  const sampled = evaluated.camera;
  const values = [sampled.azimuth, sampled.elevation, sampled.distance];
  if (!values.every((value) => Number.isFinite(value))) return null;
  return {
    azimuth: sampled.azimuth,
    elevation: sampled.elevation,
    distance: sampled.distance,
    focusOffset: { ...sampled.focusOffset }
  };
}
