/**
 * 拍摄镜头预览的宿主 scene 输入派生
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D7/D8）。
 *
 * 渲染层只消费**只读派生**，因此这里把两件事投影成 `buildCanvasRenderScene` 的输入：
 *
 * 1. `shotPreviews`：每张预览卡片的本地状态与播放进度。进度/播放只承载本地播放投影，
 *    不是 canonical；失败状态来自共享动作校验门禁（不伪造画布/GPU 就绪）。
 * 2. `shotPreviewCameraProjection`：归属线的画布 2D 起点。起点取**该镜头相机标记（小相机）**
 *    的投影：静态与非活动动态镜头用 `initialCamera`，活动动态镜头用**同一 T** 的采样相机
 *    （与 Rust `AnimationCameraState` 同一公式），再经与 Rust `sampled_camera_pose` 相同的
 *    场景→显示变换映射，因此虚线接在小模型本体上而不是片场徽标（整个场景模型）的中心。
 *    相机标记/包围球不可用时退回徽标中心，仍保留「拍摄归属」可读。
 *
 * 本模块纯函数、无副作用：不写 ServerCanvas / CanvasCommand / Y.Doc，也不创建第二份权威数据。
 */
import {
  addVec3,
  checkAnimationMotion,
  filmSetDisplayTransform,
  getGroupLayoutSizes,
  getWoohaa3CanvasNodeAbsolutePosition,
  groupBadgeRect,
  groupModelProjection,
  managedShotPreviewOwnershipOf,
  mapFilmSetSceneCamera,
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
import {
  filmSetDisplayRotation,
  filmSetDisplayScale,
  modelBounds,
  type FocusTargetInput
} from "./model-focus-session.js";
import type { MediaContentService } from "../../../extension-api/media-content.js";

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
  /** 已解析的模型聚焦目标集合（片场世界包围球与徽标投影的共享事实源）。 */
  targets: readonly FocusTargetInput[];
  mediaContent?: MediaContentService;
};

/**
 * 归属线起点。
 *
 * 优先取**镜头相机标记（小相机）**的投影：虚线要接到该镜头自己的小模型上，而不是所有镜头
 * 都汇到片场徽标（整个场景模型）的中心。相机标记或包围球不可用（资源未就绪、几何非法）时
 * 退回徽标中心，仍然保留「拍摄归属」可读，不伪造相机姿态。
 */
export function shotPreviewLinkOrigin(
  badge: { center: { x: number; y: number } } | null,
  cameraProjection: { x: number; y: number } | null
): { x: number; y: number } | null {
  if (cameraProjection) return cameraProjection;
  return badge ? { x: badge.center.x, y: badge.center.y } : null;
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
    // A valid script does not mean the cached media belongs to this revision.
    // Compare synchronously as the provider reconciliation runs in a microtask.
    const ref = canvas.nodeData[node.id]?.mediaContent;
    if (gate.canPreview && managedShotPreviewOwnershipOf(nodeData[node.id]) && ref) {
      const media = source.mediaContent?.state(node.id);
      let current = false;
      try {
        current = !!source.mediaContent && (node.type === "image" || node.type === "video")
          && source.mediaContent.describe(canvas, ref, node.type).sourceIdentity === media?.sourceIdentity;
      } catch { /* Live preview remains available while the provider resolves. */ }
      if (!current || media?.status !== "ready" || !media.asset) local.state = "stale";
    }
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
   * 与 Bevy 绘制同源：徽标 = 该组模型投影包围盒（共享画布模型单位），以组结构底边中点向下 40
   * 画的锚点顶边对齐、只向下展开。投影复用聚焦目标里同一份已 prepared 模型几何
   * （`groupModelProjection`），不按组宽取景（change: 2026-10-31-render-film-set-badge-at-model-units）。
   */
  const badgeRectOf = (filmSetNodeId: string): { x: number; y: number; width: number; height: number; center: { x: number; y: number } } | null => {
    const node = canvas.document.nodes.find((entry) => entry.id === filmSetNodeId);
    if (!node || node.type !== "group") return null;
    const target = targets.get(filmSetNodeId);
    const world = getWoohaa3CanvasNodeAbsolutePosition(node, new Map(canvas.document.nodes.map((entry) => [entry.id, entry])));
    const layout = getGroupLayoutSizes(canvas.document.nodes).get(filmSetNodeId);
    const projection = target
      ? groupModelProjection({
        sceneVersion: target.sceneVersion,
        ops: target.ops as never,
        extent: target.extent,
        aabb: target.aabb ?? undefined,
        placement: target.placement,
        badgeTopAnchored: true
      })
      : null;
    if (!projection) return null;
    const rect = {
      x: world.x,
      y: world.y,
      width: layout?.width ?? node.width ?? 180,
      height: layout?.height ?? node.height ?? 112
    };
    return groupBadgeRect(rect, projection);
  };

  const shotPreviewCameraProjection = (filmSetNodeId: string, clipId: string): { x: number; y: number } | null => {
    const data = filmSetData(filmSetNodeId);
    if (!data) return null;
    const resolved = resolveFilmSetClip(data, clipId);
    if (!resolved) return null;
    // 起点 = 该镜头相机标记（小相机）的画布投影：与 Bevy `filmset_camera` 的
    // `sampled_camera_pose` 共用「场景→显示」相似变换，虚线端头因此落在小模型本体上，
    // 而不是汇到片场徽标（整个场景模型）的中心。
    const badge = badgeRectOf(filmSetNodeId);
    const target = targets.get(filmSetNodeId);
    const bounds = target ? boundsOf(filmSetNodeId) : null;
    if (!target || !bounds) return shotPreviewLinkOrigin(badge, null);
    const live = playback
      ? playback.viewMode === "shot-node-preview" &&
        playback.nodeId === filmSetNodeId &&
        playback.clipId === clipId
      : false;
    // 活动动态镜头与 Rust `marker_targets` 同门禁：采样失败时标记不绘制，线也不伪造相机姿态。
    const sampled = live && playback ? sampledCamera(playback) : null;
    if (live && !sampled) return shotPreviewLinkOrigin(badge, null);
    const camera = sampled ?? resolved.initialCamera;
    const transform = filmSetDisplayTransform({
      scale: filmSetDisplayScale(target),
      yaw: filmSetDisplayRotation(target)
    });
    if (!transform.ok) return shotPreviewLinkOrigin(badge, null);
    const mapped = mapFilmSetSceneCamera(transform.value, bounds.center, camera);
    if (!mapped) return shotPreviewLinkOrigin(badge, null);
    const focus = addVec3(bounds.center, mapped.focusOffset);
    const position = shotCameraPosition(focus, mapped.azimuth, mapped.distance, camera.elevation);
    if (![...focus, ...position].every((value) => Number.isFinite(value))) {
      return shotPreviewLinkOrigin(badge, null);
    }
    const projected = worldToCanvasPoint(position);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
      return shotPreviewLinkOrigin(badge, null);
    }
    return shotPreviewLinkOrigin(badge, { x: projected.x, y: projected.y });
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
