/**
 * 共享世界对象的直接地面拖动（普通画布入口，不含镜头）。
 *
 * 世界模型没有内容卡片：指针命中来自渲染器 `queryModelPick` 的真实表面/空模型锚点，
 * 所以拖动不能复用卡片 `drag` 手势的位置预览（那写的是卡片 `position`）。这里把两个
 * 地面点转成米制增量：
 *
 * - 每次移动只更新控制器的瞬时 `worldGroundPreviews`（与导演区搬动的预览同一通道），
 *   不写规范状态、不发命令、不改卡片布局；
 * - 释放时才提交 `nodeData.patch`，写入新的 `sharedWorldInstance.transform.position`，
 *   完整保留原始 `instanceId`、姿态、尺度与高度 h；撤销即恢复旧变换。
 *
 * 纯规则（命中筛选、增量、是否达到提交阈值、提交计划）集中在本文件，便于回归。
 */
import {
  createWorldAnimationScript,
  decodeSceneAreaData,
  decodeWorldInstanceData,
  encodeWorldInstanceData,
  executeWorldAnimationScript,
  sampleWorldAnimationInArea,
  sceneAreaAnimationOrigin,
  serializeWorldAnimationScript,
  type CanvasCommand,
  type CanvasNodeData,
  type GroundAabb,
  type GroundPoint,
  type ServerCanvas,
  type WorldPoint
} from "@woohaa3/contracts";

/** 地面拖动中的一个世界实例目标。 */
export type WorldGroundDragTarget = {
  nodeId: string;
  /** 按下瞬间的规范实例数据（JSON），用于检测外部改写与空操作。 */
  source: string;
  /** 已解码的实例数据；提交时以它为底。 */
  instance: NonNullable<ReturnType<typeof instanceOf>>;
};

/** 地面拖动的起点：命中的世界实例、同批拖动的全部实例与按下时的地面点。 */
export type WorldGroundDragStart = {
  /** 按下（锚点）的世界实例；单实例拖动时等于唯一的 target。 */
  nodeId: string;
  /** 按下实例的规范数据（JSON）；兼容既有单实例调用。 */
  source: string;
  /** 按下实例的解码数据；兼容既有单实例调用。 */
  instance: NonNullable<ReturnType<typeof instanceOf>>;
  /** 本轮一起移动的全部世界实例；包含按下实例。 */
  targets: WorldGroundDragTarget[];
  start: GroundPoint;
};

function instanceOf(canvas: ServerCanvas | null | undefined, nodeId: string) {
  const decoded = decodeWorldInstanceData(canvas?.nodeData?.[nodeId]?.sharedWorldInstance);
  return decoded.ok ? decoded.value : null;
}

/** 该节点是否是可拖动的共享世界模型（`sharedWorldInstance` 合法且节点存在）。 */
export function isWorldDragTarget(canvas: ServerCanvas | null | undefined, nodeId: string | null): boolean {
  if (!canvas || !nodeId) return false;
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return false;
  return instanceOf(canvas, nodeId) !== null;
}

/**
 * 开始一次地面拖动。
 *
 * `ground` 来自 `controller.queryWorldGround`：聚焦/过渡/模态期间为 `null`，此时返回
 * `null` 让调用方走其余手势分支（例如地面拖动框选）。
 */
export function beginWorldGroundDrag(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null,
  ground: GroundPoint | null
): WorldGroundDragStart | null {
  return beginWorldGroundDragMany(canvas, nodeId ? [nodeId] : [], nodeId, ground);
}

/**
 * 开始一次多实例地面拖动：把当前选区里的世界实例一起作为目标。
 *
 * 非世界实例（卡片、导演区、镜头）会被过滤；按下实例必须仍是有效世界实例，否则
 * 整个手势不开始，避免把一次混合选区拖动降级成只移动某个旁观对象。
 */
export function beginWorldGroundDragMany(
  canvas: ServerCanvas | null | undefined,
  nodeIds: readonly string[],
  pressedNodeId: string | null,
  ground: GroundPoint | null
): WorldGroundDragStart | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  if (!canvas || !pressedNodeId) return null;
  const targets: WorldGroundDragTarget[] = [];
  const seen = new Set<string>();
  for (const nodeId of [...nodeIds, pressedNodeId]) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const instance = instanceOf(canvas, nodeId);
    if (!instance) continue;
    targets.push({
      nodeId,
      // 用解码后的规范化值作并发基线：原始 JSON 的键顺序变化不应误判为外部改写。
      source: JSON.stringify(instance),
      instance
    });
  }
  const pressed = targets.find(target => target.nodeId === pressedNodeId);
  if (!pressed) return null;
  return {
    nodeId: pressedNodeId,
    source: pressed.source,
    instance: pressed.instance,
    targets,
    start: { u: ground.u, v: ground.v }
  };
}

/**
 * 指针移动：确认实例未被并发改写后，返回相对起点的地面增量。
 *
 * `null` 表示这次手势已失效（节点删除/实例被外部改写），调用方应取消预览。
 */
export function worldGroundDelta(
  start: WorldGroundDragStart,
  canvas: ServerCanvas | null | undefined,
  ground: GroundPoint | null
): GroundPoint | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  // 任一目标被外部改写/删除都取消整次手势，避免只提交半批位移。
  for (const target of start.targets) {
    const current = instanceOf(canvas, target.nodeId);
    if (!current || JSON.stringify(current) !== target.source) return null;
  }
  return { u: ground.u - start.start.u, v: ground.v - start.start.v };
}

/** 释放时是否应提交：位移达到 1cm 才写，避免误点产生一条撤销记录。 */
export function worldGroundMoved(delta: GroundPoint | null | undefined): delta is GroundPoint {
  if (!delta || !Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return false;
  return Math.abs(delta.u) > 0.01 || Math.abs(delta.v) > 0.01;
}

/**
 * 释放提交：只改地面 `u/v`，保留 `h`、旋转、缩放与 `instanceId`。
 *
 * 返回 `null` 表示无净变化或实例已失效（不提交，撤销历史不新增空条目）。
 */
export function planWorldGroundMove(
  start: WorldGroundDragStart,
  delta: GroundPoint | null | undefined
): CanvasCommand[] | null {
  if (!worldGroundMoved(delta)) return null;
  const commands: CanvasCommand[] = [];
  for (const target of start.targets) {
    const transform = target.instance.transform;
    const next = {
      ...target.instance,
      transform: {
        ...transform,
        position: {
          u: transform.position.u + delta.u,
          v: transform.position.v + delta.v,
          h: transform.position.h
        }
      }
    };
    if (!decodeWorldInstanceData(next).ok) return null;
    // 复用共享 codec 的规范化输出（纯 JSON），与契约其它世界写入入口一致。
    const sharedWorldInstance = encodeWorldInstanceData(next) as CanvasNodeData["sharedWorldInstance"];
    commands.push({ type: "nodeData.patch", nodeId: target.nodeId, value: { sharedWorldInstance } });
  }
  return commands;
}

export type WorldGroundUnbindCandidate = {
  areaNodeId: string;
  title: string;
};

export type WorldGroundMoveAnimationPlan = {
  /** 规范命令：实例基础变换 + 动画脚本平移/解绑（直接提交，外部撤销条目）。 */
  forward: CanvasCommand[];
  /** 撤销命令：实例基础变换 + 动画脚本恢复原值。 */
  inverse: CanvasCommand[];
  /** 是否包含动画脚本改写；false 时走普通编辑历史。 */
  animated: boolean;
  /** 本次移动会让模型离开其动画所属导演区；确认后才真正提交。 */
  unbindCandidates: WorldGroundUnbindCandidate[];
};

function insideArea(bounds: GroundAabb, point: GroundPoint): boolean {
  return point.u >= bounds.min.u && point.u <= bounds.max.u
    && point.v >= bounds.min.v && point.v <= bounds.max.v;
}

function instancePatch(nodeId: string, instance: ReturnType<typeof instanceOf> & object, position: WorldPoint): CanvasCommand | null {
  const next = { ...instance, transform: { ...instance.transform, position } };
  if (!decodeWorldInstanceData(next).ok) return null;
  return {
    type: "nodeData.patch",
    nodeId,
    value: { sharedWorldInstance: encodeWorldInstanceData(next) as CanvasNodeData["sharedWorldInstance"] }
  };
}

/**
 * 拖动由导演区动画脚本驱动的实例：
 *
 * - 仍在动画所属导演区内：把实例基础同步到当前采样位置，并把 `position` 轨道整体平移；
 * - 移出该导演区：调用方先确认，确认后移除该实例在脚本里的全部轨道（解绑），
 *   基础同步到新位置，画面停在拖动后的位置；
 * - 取消：调用方不提交，模型留在原处。
 *
 * 动画脚本属于 sceneArea 字段，普通编辑规划只认识少数 nodeData 字段；为避免把所有导演区的
 * 规范化差异卷进编辑计划，带动画的拖动由调用方直接提交并登记外部撤销。
 */
export function planWorldGroundMoveWithAnimationParts(
  canvas: ServerCanvas | null | undefined,
  start: WorldGroundDragStart,
  delta: GroundPoint | null | undefined,
  times?: ReadonlyMap<string, number>,
  unbindAreaIds?: ReadonlySet<string>
): WorldGroundMoveAnimationPlan | null {
  if (!worldGroundMoved(delta)) return null;
  if (!canvas || !delta) {
    const plain = planWorldGroundMove(start, delta);
    return plain ? { forward: plain, inverse: [], animated: false, unbindCandidates: [] } : null;
  }
  const instanceIds = new Set(start.targets.map(target => target.instance.instanceId));
  const animatedPositions = new Map<string, WorldPoint>();
  const forwardAreas: CanvasCommand[] = [];
  const inverseAreas: CanvasCommand[] = [];
  const unbindCandidates: WorldGroundUnbindCandidate[] = [];
  for (const node of canvas.document.nodes) {
    if (node.type !== "scene-area") continue;
    const nodeData = canvas.nodeData[node.id] as Record<string, unknown> | undefined;
    const area = decodeSceneAreaData(nodeData?.sceneArea);
    if (!area.ok || !area.value.animationScript) continue;
    const script = area.value.animationScript;
    const executed = executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop });
    if (!executed.ok) continue;
    if (!executed.ir.instanceTracks.some(track => instanceIds.has(track.targetId))) continue;
    const unbind = unbindAreaIds?.has(node.id) === true;
    let changed = false;
    const instanceTracks = unbind
      ? executed.ir.instanceTracks.filter(track => {
          if (!instanceIds.has(track.targetId)) return true;
          changed = true;
          return false;
        })
      : executed.ir.instanceTracks.map(track => {
          if (track.property !== "position" || !instanceIds.has(track.targetId) || track.from.length < 2 || track.to.length < 2) return track;
          changed = true;
          const from = [...track.from];
          const to = [...track.to];
          from[0] = from[0]! + delta.u;
          from[1] = from[1]! + delta.v;
          to[0] = to[0]! + delta.u;
          to[1] = to[1]! + delta.v;
          return { ...track, from, to };
        });
    if (!changed) continue;
    const sampled = sampleWorldAnimationInArea(
      executed.ir,
      times?.get(node.id) ?? 0,
      sceneAreaAnimationOrigin(area.value)
    ).instances;
    for (const instanceId of instanceIds) {
      const position = sampled.get(instanceId)?.position;
      if (position) animatedPositions.set(instanceId, position);
      if (!unbind && !unbindAreaIds) {
        const target = start.targets.find(entry => entry.instance.instanceId === instanceId);
        if (!target) continue;
        const old = position ?? target.instance.transform.position;
        const next = { u: old.u + delta.u, v: old.v + delta.v };
        if (insideArea(area.value.bounds, old) && !insideArea(area.value.bounds, next)) {
          if (!unbindCandidates.some(candidate => candidate.areaNodeId === node.id)) {
            const title = typeof nodeData?.title === "string" && nodeData.title.trim() !== "" ? nodeData.title.trim() : "导演区";
            unbindCandidates.push({ areaNodeId: node.id, title });
          }
        }
      }
    }
    const nextScript = createWorldAnimationScript({
      script: serializeWorldAnimationScript({ ...executed.ir, instanceTracks }),
      duration: script.duration,
      loop: script.loop,
      revision: script.revision + 1
    });
    // 保留 raw sceneArea 的其它 allowlist 字段（包括读取期容忍的 legacy `animation`），
    // 只替换/移除 animationScript；撤销回到完整原值。
    const rawArea = (nodeData?.sceneArea ?? area.value) as Record<string, unknown>;
    const value = (nextArea: Record<string, unknown>): CanvasNodeData => ({
      ...(nodeData ?? {}),
      sceneArea: nextArea
    }) as unknown as CanvasNodeData;
    if (unbind && instanceTracks.length === 0 && executed.ir.cameraTracks.length === 0) {
      const { animationScript: _removed, ...rest } = rawArea;
      forwardAreas.push({ type: "nodeData.patch", nodeId: node.id, value: value(rest) });
    } else {
      forwardAreas.push({ type: "nodeData.patch", nodeId: node.id, value: value({ ...rawArea, animationScript: nextScript }) });
    }
    inverseAreas.push({ type: "nodeData.patch", nodeId: node.id, value: value(rawArea) });
  }
  const forward: CanvasCommand[] = [];
  const inverse: CanvasCommand[] = [];
  for (const target of start.targets) {
    const transform = target.instance.transform;
    const base = animatedPositions.get(target.instance.instanceId) ?? transform.position;
    const moved = instancePatch(target.nodeId, target.instance, {
      u: base.u + delta.u,
      v: base.v + delta.v,
      h: base.h
    });
    const original = instancePatch(target.nodeId, target.instance, transform.position);
    if (!moved || !original) return null;
    forward.push(moved);
    inverse.push(original);
  }
  const animated = forwardAreas.length > 0;
  if (!animated) {
    // 非动画目标只走普通编辑历史（保持冲突前置条件与原有撤销语义）。
    const plain = planWorldGroundMove(start, delta);
    return plain ? { forward: plain, inverse: [], animated: false, unbindCandidates: [] } : null;
  }
  return { forward: [...forward, ...forwardAreas], inverse: [...inverse, ...inverseAreas], animated: true, unbindCandidates };
}

/** 兼容既有调用：返回正向前向命令。 */
export function planWorldGroundMoveWithAnimation(
  canvas: ServerCanvas | null | undefined,
  start: WorldGroundDragStart,
  delta: GroundPoint | null | undefined,
  times?: ReadonlyMap<string, number>,
  unbindAreaIds?: ReadonlySet<string>
): CanvasCommand[] | null {
  return planWorldGroundMoveWithAnimationParts(canvas, start, delta, times, unbindAreaIds)?.forward ?? null;
}
