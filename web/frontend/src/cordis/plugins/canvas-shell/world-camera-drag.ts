/**
 * 共享世界镜头的视锥直接拖动（镜头呈现的普通画布入口）。
 *
 * 镜头和世界模型一样只有 3D 身影（视锥 + 机位），指针命中来自渲染器的
 * `queryModelPick`。拖动语义：
 *
 * - 命中视锥边/角：绕镜头自身位置转动朝向（方位/俯仰），地面拖动量按固定灵敏度换算
 *   成偏航与俯仰增量，保持等距姿态仍满足 `shared-world-v1` 的等距方向规则；
 * - 命中视锥内部/镜头本体：整体平移机位，保持朝向、投影、画幅与绑定。
 *
 * 移动期间只更新控制器的瞬时 `worldCameraPreviews`（不写规范状态、不发命令）；
 * 释放时才经权威 `world-camera-save` 提交（`expectedSettingsVersion` 防并发覆盖），
 * 提交成功才把可逆回调记进页面撤销历史。纯规则（命中拆分、增量 → 位姿、增量 → 命令）
 * 集中在本文件，便于回归。
 */
import {
  createWorldAnimationScript,
  decodeSceneAreaData,
  decodeWorldCamera,
  executeWorldAnimationScript,
  sampleWorldAnimationInArea,
  sceneAreaAnimationOrigin,
  serializeWorldAnimationScript,
  worldCameraUiSettingsOf,
  worldToCanvasPoint,
  worldToRendererPosition,
  type CanvasCommand,
  type CanvasNodeData,
  type GroundAabb,
  type GroundPoint,
  type SceneAreaData,
  type ServerCanvas,
  type WorldAnimationIr,
  type WorldAnimationScript,
  type WorldCameraData,
  type WorldCameraTrack,
  type WorldPoint,
  type WorldRotation
} from "@woohaa3/contracts";

/** 命中视锥的哪一部分：旋转朝向 / 整体平移。 */
export type WorldCameraDragMode = "rotate" | "move";

/** 镜头拖动的起点：命中节点、按下时的规范镜头与地面点。 */
export type WorldCameraDragStart = {
  nodeId: string;
  /** 按下瞬间的规范镜头数据（JSON），用于检测外部改写与空操作。 */
  source: string;
  /** 拖拽使用的有效位姿：动画镜头取当前采样位姿，普通镜头等于规范位姿。 */
  camera: WorldCameraData;
  /** 规范镜头；撤销与版本校验始终以它为准。 */
  canonical: WorldCameraData;
  mode: WorldCameraDragMode;
  start: GroundPoint;
  /** 按下时的卡片左上角（绝对画布坐标），用于撤销/重做时一起还原。 */
  card: { x: number; y: number };
  /** 按下时的机位画布投影；卡片按同一画布位移跟随，保持相对位置。 */
  cameraCanvas: { x: number; y: number };
};

export type WorldCameraPose = { position: WorldPoint; rotation: WorldRotation };

/** 地面地平线的俯仰下限/上限（弧度）：不允许把镜头转到直视下方或翻过天顶。 */
const MIN_PITCH = -1.35;
const MAX_PITCH = 1.35;
/** 每米地面拖动的朝向增量（弧度）。12 米处可见视锥，0.35 得到约 4° / 米的手感。 */
const YAW_PER_METER = 0.35;
const PITCH_PER_METER = 0.25;

function cameraOf(canvas: ServerCanvas | null | undefined, nodeId: string | null) {
  if (!canvas || !nodeId) return null;
  const decoded = decodeWorldCamera(canvas.nodeData?.[nodeId]?.worldCamera);
  return decoded.ok ? decoded.value : null;
}

/** 该节点是否是可拖动的共享世界镜头（`worldCamera` 合法且节点存在）。 */
export function isWorldCameraTarget(canvas: ServerCanvas | null | undefined, nodeId: string | null): boolean {
  if (!canvas || !nodeId) return false;
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return false;
  return cameraOf(canvas, nodeId) !== null;
}

/**
 * 开始一次镜头拖动。
 *
 * `ground` 来自 `controller.queryWorldGround`：聚焦/过渡/模态期间为 `null`，此时返回
 * `null` 让调用方走其余手势分支。`mode` 由指针路径对渲染器视锥边的命中结果给出。
 */
export function beginWorldCameraDrag(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null,
  ground: GroundPoint | null,
  mode: WorldCameraDragMode,
  sampledCamera?: WorldCameraData
): WorldCameraDragStart | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  const canonical = cameraOf(canvas, nodeId);
  if (!canonical || !nodeId) return null;
  const camera = sampledCamera ?? canonical;
  const start = { u: ground.u, v: ground.v };
  const pose = poseFor(camera, mode, { u: 0, v: 0 });
  // 等距镜头的朝向必须保持等距；无法构造合法姿态时不开始手势（走点击选中）。
  if (!pose || !decodeWorldCamera({ ...camera, ...pose }).ok) return null;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  if (!node?.position) return null;
  const card = { x: node.position.x, y: node.position.y };
  const cameraCanvas = cameraCanvasPosition({ position: camera.position, rotation: camera.rotation });
  return {
    nodeId,
    source: JSON.stringify(canvas?.nodeData?.[nodeId]?.worldCamera),
    camera,
    canonical,
    mode,
    start,
    card,
    cameraCanvas
  };
}

/** 指针移动：确认镜头未被并发改写后返回相对起点的地面增量。 */
export function worldCameraDelta(
  start: WorldCameraDragStart,
  canvas: ServerCanvas | null | undefined,
  ground: GroundPoint | null
): GroundPoint | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  if (JSON.stringify(canvas?.nodeData?.[start.nodeId]?.worldCamera) !== start.source) return null;
  return { u: ground.u - start.start.u, v: ground.v - start.start.v };
}

/** 释放时是否应提交：位姿变化超过 1mm / 0.01° 才写，避免误点产生撤销条目。 */
export function worldCameraMoved(
  start: WorldCameraDragStart,
  delta: GroundPoint | null | undefined
): delta is GroundPoint {
  if (!delta || !Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return false;
  void start;
  return Math.abs(delta.u) > 1e-3 || Math.abs(delta.v) > 1e-3;
}

/**
 * 增量 → 渲染器空间位姿（米制位置 + 世界四元数）。
 *
 * 旋转：地面的 `+u` 方向拖动用世界竖直轴做偏航；`+v` 拖动用镜头自身右轴做俯仰。
 * 平移：只改地面 `u/v`，保持高度与朝向。
 */
export function poseFor(
  camera: WorldCameraData,
  mode: WorldCameraDragMode,
  delta: GroundPoint
): WorldCameraPose | null {
  if (!Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return null;
  if (mode === "move") {
    return {
      position: {
        u: camera.position.u + delta.u,
        v: camera.position.v + delta.v,
        h: camera.position.h
      },
      rotation: [...camera.rotation] as unknown as WorldRotation
    };
  }
  // 等距镜头的朝向不是任意角：`shared-world-v1` 要求三轴分量绝对值相等，只有绕竖直轴
  // 90° 的整数倍仍合法。因此等距镜头按拖动方向吸附到下一/上一象限，不叠加俯仰。
  const isometric = camera.projection.kind === "isometric";
  const yaw = isometric
    ? (Math.abs(delta.u) < 0.35 ? 0 : (delta.u > 0 ? -1 : 1) * Math.PI / 2)
    : -delta.u * YAW_PER_METER;
  const pitch = isometric ? 0 : clamp(delta.v * PITCH_PER_METER, MIN_PITCH, MAX_PITCH);
  // World basis is (u, v, h); the vertical axis is h, not Bevy's Y.
  const rotation = multiply(
    multiply(axisAngle([0, 0, 1], yaw), camera.rotation as unknown as WorldRotation),
    axisAngle(rightAxis(camera.rotation as unknown as WorldRotation), pitch)
  );
  const normalized = normalizeRotation(rotation);
  if (!normalized) return null;
  return {
    position: { ...camera.position },
    rotation: normalized
  };
}

/**
 * 释放提交：只改位姿，保留投影、画幅、输出方向与绑定。
 *
 * 空操作或姿态不再满足 `shared-world-v1`（例如透视镜头被转到退化朝向）时返回 `null`。
 */
export function planWorldCameraMove(
  start: WorldCameraDragStart,
  delta: GroundPoint | null | undefined
): { position: WorldPoint; rotation: WorldRotation } | null {
  if (!worldCameraMoved(start, delta)) return null;
  const pose = poseFor(start.camera, start.mode, delta);
  if (!pose) return null;
  if (!decodeWorldCamera({ ...start.camera, ...pose }).ok) return null;
  const unchanged = pose.position.u === start.camera.position.u
    && pose.position.v === start.camera.position.v
    && pose.position.h === start.camera.position.h
    && pose.rotation.every((value, index) =>
      Math.abs(value - start.camera.rotation[index]) <= 1e-9);
  return unchanged ? null : pose;
}

/** 提交前的完整镜头设置；与权威 save 的 `settings` 形状一致。 */
export function worldCameraSettingsOfPose(
  camera: WorldCameraData,
  pose: WorldCameraPose
) {
  return worldCameraUiSettingsOf({ ...camera, ...pose });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function axisAngle(axis: readonly number[], angle: number): WorldRotation {
  const length = Math.hypot(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0);
  if (!(length > 0) || !Number.isFinite(angle)) return [0, 0, 0, 1];
  const half = angle / 2;
  const s = Math.sin(half) / length;
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(half)];
}

/** `parent * child`（child 先作用）；与 shared-world v1 的四元数合成约定一致。 */
function multiply(a: WorldRotation, b: WorldRotation): WorldRotation {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

/** 镜头自身右轴（世界基、Y-up）：渲染器右轴 `+X` 经世界旋转得到。 */
function rightAxis(rotation: WorldRotation): number[] {
  const [x, y, z, w] = rotation;
  // rotate(q, (1,0,0))
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y)
  ];
}

function normalizeRotation(rotation: WorldRotation): WorldRotation | null {
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!(length > 1e-9) || !Number.isFinite(length)) return null;
  return [rotation[0] / length, rotation[1] / length, rotation[2] / length, rotation[3] / length];
}

/** 机位本体在画布坐标中的投影（含高度，不是地面点）。 */
export function cameraCanvasPosition(pose: WorldCameraPose): { x: number; y: number } {
  const position = worldToRendererPosition(pose.position);
  const point = worldToCanvasPoint([position[0], position[1], position[2]]);
  return { x: point.x, y: point.y };
}

/**
 * 镜头拖动时卡片的左上角：卡片与机位按同一画布位移平移，保持按下时的相对位置。
 * 不再把卡片强制对齐到机位下方/地面投影。
 */
export function cardFollowPosition(start: WorldCameraDragStart, pose: WorldCameraPose): { x: number; y: number } {
  const camera = cameraCanvasPosition(pose);
  return {
    x: start.card.x + camera.x - start.cameraCanvas.x,
    y: start.card.y + camera.y - start.cameraCanvas.y
  };
}

/** 渲染器空间位置（米制 → Bevy 世界）供诊断/测试核对。 */
export function worldCameraRendererPosition(pose: WorldCameraPose): [number, number, number] {
  return worldToRendererPosition(pose.position) as [number, number, number];
}

/** 一个正在驱动该镜头的导演区脚本。 */
export type WorldCameraAnimationArea = {
  nodeId: string;
  data: Record<string, unknown>;
  area: SceneAreaData;
  script: WorldAnimationScript;
  ir: WorldAnimationIr;
};

export type WorldCameraAnimationSample = {
  /** 当前动画时间下的有效镜头位姿；投影、绑定与版本仍取规范值。 */
  camera: WorldCameraData;
  areas: WorldCameraAnimationArea[];
};

function cameraById(canvas: ServerCanvas, cameraId: string): WorldCameraData | null {
  for (const node of canvas.document.nodes) {
    const decoded = decodeWorldCamera(canvas.nodeData?.[node.id]?.worldCamera);
    if (decoded.ok && decoded.value.cameraId === cameraId) return decoded.value;
  }
  return null;
}

/**
 * 采样所有驱动该镜头的导演区脚本。多个区同时声明时按文档顺序后者覆盖，
 * 与 `scene-builder` 的投影顺序一致。
 */
export function animatedCameraAt(
  canvas: ServerCanvas | null | undefined,
  cameraId: string,
  times?: ReadonlyMap<string, number>
): WorldCameraAnimationSample | null {
  if (!canvas) return null;
  const canonical = cameraById(canvas, cameraId);
  if (!canonical) return null;
  let position = canonical.position;
  let rotation = canonical.rotation;
  const areas: WorldCameraAnimationArea[] = [];
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id] as Record<string, unknown> | undefined;
    const decoded = decodeSceneAreaData(data?.sceneArea);
    if (!decoded.ok || !decoded.value.animationScript) continue;
    const script = decoded.value.animationScript;
    const executed = executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop });
    if (!executed.ok) continue;
    if (!executed.ir.cameraTracks.some(track => track.targetId === cameraId)) continue;
    const sample = sampleWorldAnimationInArea(
      executed.ir,
      times?.get(node.id) ?? 0,
      sceneAreaAnimationOrigin(decoded.value)
    ).cameras.get(cameraId);
    if (sample?.position) position = sample.position;
    if (sample?.rotation) rotation = sample.rotation;
    areas.push({ nodeId: node.id, data: data ?? {}, area: decoded.value, script, ir: executed.ir });
  }
  return {
    camera: { ...canonical, position, rotation },
    areas
  };
}

function insideArea(bounds: GroundAabb, point: GroundPoint): boolean {
  return point.u >= bounds.min.u && point.u <= bounds.max.u
    && point.v >= bounds.min.v && point.v <= bounds.max.v;
}

function titleOf(data: Record<string, unknown>): string {
  return typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : "导演区";
}

export type WorldCameraUnbindCandidate = {
  areaNodeId: string;
  title: string;
};

export type WorldCameraAnimationMovePlan = {
  /** 要保存到规范镜头的位姿（动画采样位姿 + 本次地面增量）。 */
  pose: WorldCameraPose;
  /** 动画脚本改动；与镜头保存分两步提交，外部撤销条目统一回放。 */
  forwardAreas: CanvasCommand[];
  inverseAreas: CanvasCommand[];
  /** 本次移动会让镜头离开动画所属导演区；确认后才真正提交。 */
  unbindCandidates: WorldCameraUnbindCandidate[];
  /** 是否有动画脚本需要改写；false 时走原有镜头保存路径。 */
  animated: boolean;
};

/**
 * 镜头拖动落点计划：位置轨道随镜头整体平移；旋转模式下手动朝向优先，
 * 移除该镜头的旋转轨道。移出动画所属导演区时返回待确认的解除绑定候选。
 */
export function planWorldCameraMoveWithAnimationParts(
  canvas: ServerCanvas | null | undefined,
  start: WorldCameraDragStart,
  delta: GroundPoint | null | undefined,
  times?: ReadonlyMap<string, number>,
  unbindAreaIds?: ReadonlySet<string>
): WorldCameraAnimationMovePlan | null {
  const pose = planWorldCameraMove(start, delta);
  if (!pose) return null;
  const sample = animatedCameraAt(canvas, start.canonical.cameraId, times);
  if (!canvas || !sample || sample.areas.length === 0) {
    return { pose, forwardAreas: [], inverseAreas: [], unbindCandidates: [], animated: false };
  }

  const unbindCandidates: WorldCameraUnbindCandidate[] = [];
  const forwardAreas: CanvasCommand[] = [];
  const inverseAreas: CanvasCommand[] = [];
  for (const area of sample.areas) {
    const unbind = unbindAreaIds?.has(area.nodeId) === true;
    let changed = false;
    const cameraTracks = (unbind
      ? area.ir.cameraTracks.filter(track => {
          if (track.targetId !== start.canonical.cameraId) return true;
          changed = true;
          return false;
        })
      : area.ir.cameraTracks
          .map((track): WorldCameraTrack | null => {
            if (track.targetId !== start.canonical.cameraId) return track;
            if (track.property === "position" && start.mode === "move") {
              changed = true;
              const from = [...track.from];
              const to = [...track.to];
              from[0] = from[0]! + delta!.u;
              from[1] = from[1]! + delta!.v;
              to[0] = to[0]! + delta!.u;
              to[1] = to[1]! + delta!.v;
              return { ...track, from, to };
            }
            // 手动旋转是显式覆盖：去掉朝向轨道，避免松手瞬间被脚本拉回。
            if (track.property === "rotation" && start.mode === "rotate") {
              changed = true;
              return null;
            }
            return track;
          })
          .filter((track): track is WorldCameraTrack => track !== null));
    if (!changed) continue;

    if (!unbind && start.mode === "move") {
      const sampled = sampleWorldAnimationInArea(
        area.ir,
        times?.get(area.nodeId) ?? 0,
        sceneAreaAnimationOrigin(area.area)
      ).cameras.get(start.canonical.cameraId);
      const from = sampled?.position ?? start.camera.position;
      const next = { u: from.u + delta!.u, v: from.v + delta!.v };
      if (insideArea(area.area.bounds, from) && !insideArea(area.area.bounds, next)) {
        unbindCandidates.push({ areaNodeId: area.nodeId, title: titleOf(area.data) });
      }
    }

    const rawArea = (area.data.sceneArea && typeof area.data.sceneArea === "object"
      ? area.data.sceneArea
      : area.area) as Record<string, unknown>;
    const nextArea: Record<string, unknown> = { ...rawArea };
    if (cameraTracks.length === 0 && area.ir.instanceTracks.length === 0 && (area.ir.partTracks?.length ?? 0) === 0 && (area.ir.walkTracks?.length ?? 0) === 0) {
      delete nextArea.animationScript;
    } else {
      nextArea.animationScript = createWorldAnimationScript({
        script: serializeWorldAnimationScript({ ...area.ir, cameraTracks }),
        duration: area.script.duration,
        loop: area.script.loop,
        revision: area.script.revision + 1
      });
    }
    const value = (next: Record<string, unknown>): CanvasNodeData =>
      ({ ...area.data, sceneArea: next }) as unknown as CanvasNodeData;
    forwardAreas.push({ type: "nodeData.patch", nodeId: area.nodeId, value: value(nextArea) });
    inverseAreas.push({ type: "nodeData.patch", nodeId: area.nodeId, value: value(rawArea) });
  }
  return {
    pose,
    forwardAreas,
    inverseAreas,
    unbindCandidates,
    animated: forwardAreas.length > 0
  };
}
