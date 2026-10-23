/**
 * 片场坐标契约 schema 3 → schema 4 的**离线**纯迁移
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 4.1–4.3 / design D5）。
 *
 * 只由启动前迁移与离线 CLI 调用；生产读取、Room.load、codec、history restore、MCP 与浏览器
 * 导入 MUST NOT 引用本模块。它不是兼容读取层。
 *
 * 语义：
 * - schema 3 内容里的镜头 `distance` / `focusOffset` 按**渲染世界单位**保存，而 items/媒体
 *   offset 是内容局部单位；schema 4 要求二者统一为**场景单位**。
 * - 这里用旧公式重建该节点当时的**确切显示映射**
 *   `s = min(placement.scale,1) × 192/extent × filmSetFit(nodeRect)`，再把世界相机反解：
 *   距离除以 `s`，偏移先逆旋转再除以 `s`；镜头运动轨道同样转换并重新执行验证。
 * - 缺少节点矩形、内容非法、映射非法或轨道无法等价表达时**不迁移**，返回具名冲突并保留原件，
 *   绝不按 distance 大小、节点名或「看起来像人物」猜测单位。
 *
 * 幂等：已为 schema 4 的节点返回 `changed:false`；同一输入重跑无净变化。
 */
import {
  FILM_SET_CONTENT_PREVIOUS_VERSION,
  FILM_SET_CONTENT_VERSION,
  canonicalFilmSetFields,
  composeFilmSetPreviewAtTime,
  decodeFilmSetNodeData,
  executeMotionScript,
  filmSetAnimationsOf,
  filmSetFitFactor,
  filmSetLayoutBounds,
  filmSetNaturalScale,
  hashMotionScript,
  prepareModelResource,
  serializeCameraMotionTracks,
  type CameraTrack,
  type FilmSetNodeData,
  type InitialShotCamera,
  type ModelPlacement
} from "@woohaa3/contracts";

/** 迁移单一节点的冲突类型（稳定、可读）。 */
export type FilmSetSceneSpaceConflict =
  | "invalid-content"
  | "missing-node-size"
  | "illegal-mapping"
  | "unsupported-motion";

export type FilmSetSceneSpaceNodeOutcome =
  | { ok: true; value: FilmSetNodeData; changed: boolean; scale: number }
  | { ok: false; reason: string; conflict: FilmSetSceneSpaceConflict };

/** 旧显示映射（`world = anchor + s × R(yaw) × scene`）。 */
export type LegacyDisplay = { scale: number; yaw: number };

/**
 * 由节点矩形与内容资源重建旧显示映射（`scale = model_unit`）。
 *
 * 无节点尺寸时返回 `null`：不能用默认尺寸假造倍率（旧记录的构图与之绑定）。
 */
export function legacyDisplayMapping(input: {
  animation: FilmSetNodeData;
  nodeSize: { width?: number; height?: number } | null | undefined;
}): LegacyDisplay | null {
  const width = input.nodeSize?.width;
  const height = input.nodeSize?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || (width as number) <= 0 || (height as number) <= 0) return null;
  const projection = composeFilmSetPreviewAtTime(
    { scenePlacement: input.animation.scenePlacement, filmSetContent: input.animation.filmSetContent },
    0
  );
  if (projection.diagnostics.length > 0) return null;
  const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops: projection.ops });
  const layout = filmSetLayoutBounds(resource.ops, input.animation.filmSetContent, resource.extent);
  // schema 3 片场没有独立根 placement：旧公式的 yaw/scale 都来自单位根。
  const placement: ModelPlacement | null = null;
  const fit = filmSetFitFactor(
    {
      sceneVersion: "woohaa-model-scene-ir-v2",
      ops: resource.ops,
      extent: resource.extent,
      aabb: layout,
      placement
    },
    { width: width as number, height: height as number }
  );
  const scale = filmSetNaturalScale(placement, resource.extent) * fit;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { scale, yaw: 0 };
}

/** 世界距离 → 场景距离。 */
export function worldToSceneDistance(display: LegacyDisplay, distance: number): number | null {
  const value = distance / display.scale;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 世界偏移 → 场景偏移（逆旋转、逆缩放）。 */
export function worldToSceneOffset(
  display: LegacyDisplay,
  offset: { x: number; y: number; z: number }
): { x: number; y: number; z: number } | null {
  const cos = Math.cos(-display.yaw);
  const sin = Math.sin(-display.yaw);
  const x = offset.x / display.scale;
  const z = offset.z / display.scale;
  const scene = { x: x * cos + z * sin, y: offset.y / display.scale, z: -x * sin + z * cos };
  return [scene.x, scene.y, scene.z].every((value) => Number.isFinite(value)) ? scene : null;
}

/** 把一条镜头从世界单位反解为场景单位。 */
export function convertCameraToSceneUnits(
  display: LegacyDisplay,
  camera: InitialShotCamera
): { camera: InitialShotCamera; changed: boolean } | null {
  if (![camera.azimuth, camera.elevation, camera.distance].every((value) => Number.isFinite(value))) return null;
  const distance = worldToSceneDistance(display, camera.distance);
  const offset = worldToSceneOffset(display, camera.focusOffset);
  if (distance === null || !offset) return null;
  const next: InitialShotCamera = {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    distance,
    aspect: camera.aspect,
    focusOffset: offset
  };
  return { camera: next, changed: JSON.stringify(next) !== JSON.stringify(camera) };
}

/**
 * 镜头运动轨道反解：距离轨道减倍率；焦点偏移轨道按轴展开（旋转会混轴），只保留非零分量。
 *
 * 无法等价表达（非有限值）返回 `null`，调用方阻断该节点迁移。
 */
export function convertCameraTracksToSceneUnits(
  display: LegacyDisplay,
  tracks: readonly CameraTrack[]
): CameraTrack[] | null {
  const result: CameraTrack[] = [];
  for (const track of tracks) {
    if (![track.startTime, track.endTime, track.from, track.to].every((value) => Number.isFinite(value))) return null;
    if (track.property === "distance") {
      const from = worldToSceneDistance(display, track.from);
      const to = worldToSceneDistance(display, track.to);
      if (from === null || to === null) return null;
      result.push({ ...track, from, to });
      continue;
    }
    if (track.property.startsWith("focusOffset.")) {
      const axis = track.property.slice("focusOffset.".length) as "x" | "y" | "z";
      const fromVector = { x: 0, y: 0, z: 0, [axis]: track.from };
      const toVector = { x: 0, y: 0, z: 0, [axis]: track.to };
      const fromScene = worldToSceneOffset(display, fromVector);
      const toScene = worldToSceneOffset(display, toVector);
      if (!fromScene || !toScene) return null;
      for (const component of ["x", "y", "z"] as const) {
        const from = fromScene[component];
        const to = toScene[component];
        if (from === 0 && to === 0) continue;
        result.push({
          ...track,
          id: `${track.id}-${component}`,
          property: `focusOffset.${component}`,
          from,
          to
        });
      }
      continue;
    }
    // azimuth / elevation 是角度，与呈现倍率无关。
    result.push({ ...track });
  }
  return result;
}

/**
 * 把单个片场 nodeData 升级到 schema 4（场景单位）。已是 schema 4 时返回 `changed:false`。
 *
 * 迁移产物必须经过生产严格 decoder 复核；失败即保留原件并报告具名冲突。
 */
export function planFilmSetSceneSpaceNode(
  nodeData: unknown,
  options: { nodeSize?: { width?: number; height?: number } | null } = {}
): FilmSetSceneSpaceNodeOutcome {
  if (!nodeData || typeof nodeData !== "object" || Array.isArray(nodeData)) {
    return { ok: false, reason: "片场 nodeData 必须是对象", conflict: "invalid-content" };
  }
  const raw = nodeData as Record<string, unknown>;
  const probe = decodeFilmSetNodeData(raw, {
    acceptedContentVersions: [FILM_SET_CONTENT_PREVIOUS_VERSION, FILM_SET_CONTENT_VERSION]
  });
  if (!probe.ok) return { ok: false, reason: probe.reason, conflict: "invalid-content" };
  const animation = probe.value;
  if (animation.filmSetContent.schemaVersion === FILM_SET_CONTENT_VERSION) {
    return { ok: true, value: animation, changed: false, scale: 1 };
  }
  const display = legacyDisplayMapping({ animation, nodeSize: options.nodeSize });
  if (!display) {
    return {
      ok: false,
      reason: "缺少可用的节点尺寸或内容布局，无法重建旧显示映射；保留原件，不按数值猜测单位",
      conflict: "missing-node-size"
    };
  }
  const sceneCamera = convertCameraToSceneUnits(display, animation.sceneCamera);
  if (!sceneCamera) return { ok: false, reason: "sceneCamera 无法反解为场景单位", conflict: "illegal-mapping" };

  const collection = filmSetAnimationsOf(animation);
  const clips = [];
  for (const clip of collection.clips) {
    const camera = convertCameraToSceneUnits(display, clip.initialCamera);
    if (!camera) return { ok: false, reason: `镜头 ${clip.id} 的构图无法反解为场景单位`, conflict: "illegal-mapping" };
    let cameraMotion = clip.cameraMotion;
    if (clip.cameraMotion.motionScript.trim()) {
      const executed = executeMotionScript(clip.cameraMotion.motionScript, { duration: clip.timeline.duration });
      if (!executed.ok) {
        return { ok: false, reason: `镜头 ${clip.id} 的运动脚本无法执行：${executed.message}`, conflict: "unsupported-motion" };
      }
      if (executed.ir.modelMotion.length > 0) {
        return { ok: false, reason: `镜头 ${clip.id} 的镜头定义含模型轨道，超出片场镜头契约`, conflict: "unsupported-motion" };
      }
      const converted = convertCameraTracksToSceneUnits(display, executed.ir.cameraMotion);
      if (!converted) {
        return { ok: false, reason: `镜头 ${clip.id} 的运动轨道无法等价表达为场景单位`, conflict: "unsupported-motion" };
      }
      const script = serializeCameraMotionTracks(converted);
      const replayed = executeMotionScript(script, { duration: clip.timeline.duration });
      if (!replayed.ok || !sameTrackShape(replayed.ir.cameraMotion, converted)) {
        return { ok: false, reason: `镜头 ${clip.id} 的场景单位轨道无法逐条复现`, conflict: "unsupported-motion" };
      }
      cameraMotion = { ...clip.cameraMotion, motionScript: script, sourceHash: hashMotionScript(script) };
    }
    clips.push({ ...clip, initialCamera: camera.camera, cameraMotion });
  }

  const candidate: Record<string, unknown> = {
    ...raw,
    filmSetContent: { schemaVersion: FILM_SET_CONTENT_VERSION, items: animation.filmSetContent.items },
    sceneCamera: sceneCamera.camera,
    filmSetAnimations: { schemaVersion: collection.schemaVersion, defaultClipId: collection.defaultClipId, clips }
  };
  const decoded = decodeFilmSetNodeData(candidate);
  if (!decoded.ok) return { ok: false, reason: decoded.reason, conflict: "invalid-content" };
  return { ok: true, value: decoded.value, changed: true, scale: display.scale };
}

/** 轨道逐条形状一致（属性/区间/缓动/数值），用于验证脚本重跑等价。 */
function sameTrackShape(left: readonly CameraTrack[], right: readonly CameraTrack[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.property !== b.property || a.easing !== b.easing) return false;
    for (const key of ["startTime", "endTime", "from", "to"] as const) {
      if (Math.abs(a[key] - b[key]) > 1e-6) return false;
    }
  }
  return true;
}

/** 迁移算法版本（进入 dry-run 计划与报告）。 */
export const FILM_SET_SCENE_SPACE_MIGRATION_VERSION = "film-set-scene-space-v1";

/** 该片场节点是否需要坐标迁移（供 dry-run 概览）。 */
export function needsFilmSetSceneSpaceMigration(nodeData: unknown): boolean {
  if (!nodeData || typeof nodeData !== "object") return false;
  const content = (nodeData as { filmSetContent?: { schemaVersion?: unknown } }).filmSetContent;
  return content?.schemaVersion === FILM_SET_CONTENT_PREVIOUS_VERSION;
}

/**
 * dry-run 的坐标来源分类：回答「这个片场是否需要迁移、能否精确反解」。
 *
 * 只做只读判定，不改写任何内容；无法证明单位时返回 `conflict`，绝不按 distance 大小或节点名
 * 猜测（change: 2026-10-23-isolate-film-set-camera-space，任务 4.1 / design D5）。
 */
export type FilmSetSceneSpaceAudit =
  | { status: "current" }
  | { status: "migratable"; displayScale: number }
  | { status: "conflict"; conflict: FilmSetSceneSpaceConflict; reason: string };

export function auditFilmSetSceneSpace(
  nodeData: unknown,
  nodeSize: { width?: number; height?: number } | null | undefined
): FilmSetSceneSpaceAudit {
  if (!nodeData || typeof nodeData !== "object") {
    return { status: "conflict", conflict: "invalid-content", reason: "nodeData 必须是对象" };
  }
  if (!needsFilmSetSceneSpaceMigration(nodeData)) return { status: "current" };
  const probe = decodeFilmSetNodeData(nodeData as Record<string, unknown>, {
    acceptedContentVersions: [FILM_SET_CONTENT_PREVIOUS_VERSION, FILM_SET_CONTENT_VERSION]
  });
  if (!probe.ok) return { status: "conflict", conflict: "invalid-content", reason: probe.reason };
  const display = legacyDisplayMapping({ animation: probe.value, nodeSize });
  if (!display) {
    return {
      status: "conflict",
      conflict: "missing-node-size",
      reason: "缺少可用的节点尺寸或内容布局，无法重建旧显示映射"
    };
  }
  const planned = planFilmSetSceneSpaceNode(nodeData, { nodeSize });
  if (!planned.ok) return { status: "conflict", conflict: planned.conflict, reason: planned.reason };
  return { status: "migratable", displayScale: display.scale };
}

/** 输出的规范 flat 字段（写回 checkpoint 时使用）。 */
export function sceneSpaceNodeFields(value: FilmSetNodeData): Record<string, unknown> {
  return canonicalFilmSetFields(value);
}
