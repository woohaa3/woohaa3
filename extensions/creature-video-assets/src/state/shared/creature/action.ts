import { z } from 'zod';
import { clipGenerationWithDefaults } from './clip-generation';
import { ValidationError } from './errors';
import type { DirectionId } from './ids';
import { motionContractSchema, assertValidMotionContract } from './motion-contract';
import { zDirectionId } from './zod-helpers';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/);

export const ANCHOR_ROLES = ['start', 'event', 'end'] as const;
export const ANCHOR_SOURCES = ['direction_still', 'kino_generated', 'previous_video_last_frame'] as const;

export const anchorDefinitionSchema = z
  .object({
    anchorId: identifier,
    actionStateId: identifier,
    directionId: zDirectionId,
    role: z.enum(ANCHOR_ROLES),
    frame: z.number().int().nonnegative(),
    description: z.string().min(1).max(300),
    source: z.enum(ANCHOR_SOURCES),
    reusedFromArtifactId: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type AnchorDefinition = z.infer<typeof anchorDefinitionSchema>;

/**
 * 一个 clip 内部的分段：同一段视频里先循环、末尾接作者收势时，用它声明可播放区段，
 * 运行时按区段选择，不需要为收势单独生成第二段视频（见 AGENTS.md 的硬切不变式）。
 */
export const CLIP_SEGMENT_ROLES = ['loop', 'stop'] as const;

export const clipSegmentSchema = z
  .object({
    segmentId: identifier,
    role: z.enum(CLIP_SEGMENT_ROLES),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
  })
  .strict();
export type ClipSegment = z.infer<typeof clipSegmentSchema>;

export const actionStateSchema = z
  .object({
    stateId: identifier,
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(600),
    kind: z.enum(['loop', 'one_shot']),
    phase: z.enum(['idle', 'entry', 'loop', 'exit', 'one_shot', 'terminal']),
    directionCoverage: z.array(zDirectionId).min(1).max(8),
    durationSeconds: z.number().positive().max(100),
    fps: z.literal(24),
    mirrorSafe: z.boolean(),
    handednessConstraints: z.array(z.string().min(1).max(200)).max(16),
    startAnchor: anchorDefinitionSchema,
    endAnchor: anchorDefinitionSchema,
    motionContract: motionContractSchema,
    clipSegments: z.array(clipSegmentSchema).max(4).default([]),
    terminal: z.boolean(),
    /** 生成期的衔接与时间轴差异；缺省即通用行为，见 clipGenerationWithDefaults。 */
    clipGeneration: clipGenerationWithDefaults,
  })
  .strict();
export type ActionState = z.infer<typeof actionStateSchema>;

export const stateTransitionSchema = z
  .object({
    transitionId: identifier,
    fromStateId: identifier,
    toStateId: identifier,
    directions: z.array(zDirectionId).min(1).max(8),
    fromEndAnchorId: identifier,
    toStartAnchorId: identifier,
    authoredConnector: z.enum(['none', 'stop_or_exit_clip']),
    hardCutRequired: z.literal(true),
  })
  .strict();
export type StateTransition = z.infer<typeof stateTransitionSchema>;

export const actionGraphSchema = z
  .object({
    schema: z.literal('project-a.creature-video-action-graph.v1'),
    fps: z.literal(24),
    initialStateId: identifier,
    actionOrder: z.array(identifier).min(1).max(24),
    states: z.array(actionStateSchema).min(1).max(24),
    transitions: z.array(stateTransitionSchema).max(64),
  })
  .strict();
export type ActionGraph = z.infer<typeof actionGraphSchema>;

export function assertValidActionGraph(graph: ActionGraph, selectedDirections: readonly DirectionId[]): void {
  const problems: string[] = [];
  const statesById = new Map(graph.states.map(state => [state.stateId, state]));
  if (statesById.size !== graph.states.length) problems.push('state id 必须唯一');
  if (new Set(graph.actionOrder).size !== graph.actionOrder.length) problems.push('actionOrder 不能重复');
  for (const stateId of graph.actionOrder) if (!statesById.has(stateId)) problems.push(`actionOrder 引用不存在的 state ${stateId}`);
  const initial = statesById.get(graph.initialStateId);
  if (!initial) problems.push(`初始 state ${graph.initialStateId} 不存在`);
  else if (initial.phase !== 'idle') problems.push('初始 state 必须是 idle 阶段');
  for (const direction of selectedDirections) {
    if (!graph.states.some(state => state.phase === 'idle' && state.directionCoverage.includes(direction))) {
      problems.push(`方向 ${direction} 缺少 Idle`);
    }
  }
  for (const state of graph.states) problems.push(...stateProblems(state, selectedDirections));
  problems.push(...generationProblems(graph, statesById));
  problems.push(...transitionProblems(graph, statesById));
  if (problems.length) throw new ValidationError(`action graph 校验失败：${problems.join('；')}`, { problems });
}

function stateProblems(state: ActionState, selectedDirections: readonly DirectionId[]): string[] {
  const problems: string[] = [];
  for (const direction of state.directionCoverage) {
    if (!selectedDirections.includes(direction)) problems.push(`state ${state.stateId} 覆盖了未选中的方向 ${direction}`);
  }
  try {
    assertValidMotionContract(state.motionContract);
  } catch (error) {
    problems.push(`state ${state.stateId} 的 ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedFrames = state.durationSeconds * state.fps;
  if (Math.abs(expectedFrames - state.motionContract.frameCount) > 1) {
    problems.push(`state ${state.stateId} 的 durationSeconds 与 frameCount/fps 不一致`);
  }
  if (state.motionContract.frameCount !== Math.round(expectedFrames)) {
    problems.push(`state ${state.stateId} 的 frameCount 必须等于 round(durationSeconds * fps)`);
  }
  // anchor 的 directionId 只是模板方向；阶段 6 会按 directionCoverage 实例化每个方向。
  for (const [label, anchor] of [['start', state.startAnchor], ['end', state.endAnchor]] as const) {
    if (anchor.actionStateId !== state.stateId) problems.push(`state ${state.stateId} 的 ${label} anchor 未指向自身`);
  }
  if (state.startAnchor.role !== 'start') problems.push(`state ${state.stateId} 的 startAnchor.role 必须是 start`);
  if (state.endAnchor.role !== 'end') problems.push(`state ${state.stateId} 的 endAnchor.role 必须是 end`);
  if (state.startAnchor.frame !== 0) problems.push(`state ${state.stateId} 的 startAnchor.frame 必须是 0`);
  if (state.endAnchor.frame !== state.motionContract.frameCount - 1) {
    problems.push(`state ${state.stateId} 的 endAnchor.frame 必须是末帧`);
  }
  if (state.kind === 'loop' && state.startAnchor.anchorId !== state.endAnchor.anchorId) {
    problems.push(`loop state ${state.stateId} 的首尾 anchor 必须相同才能闭合`);
  }
  if (state.terminal && state.phase !== 'terminal') problems.push(`terminal state ${state.stateId} 的 phase 必须是 terminal`);
  problems.push(...segmentProblems(state));
  return problems;
}

/** 片段区段必须无空隙、无重叠地覆盖整段，且 loop 段排在 stop 段之前。 */
function segmentProblems(state: ActionState): string[] {
  if (!state.clipSegments.length) return [];
  const problems: string[] = [];
  const ordered = [...state.clipSegments].sort((left, right) => left.startFrame - right.startFrame);
  let expected = 0;
  for (const segment of ordered) {
    if (segment.endFrame < segment.startFrame) problems.push(`state ${state.stateId} 的片段 ${segment.segmentId} 结束帧早于开始帧`);
    if (segment.startFrame !== expected) problems.push(`state ${state.stateId} 的片段 ${segment.segmentId} 必须从第 ${expected} 帧开始`);
    expected = Math.max(expected, segment.endFrame + 1);
  }
  if (expected !== state.motionContract.frameCount) {
    problems.push(`state ${state.stateId} 的片段必须无空隙、无重叠地覆盖全部 ${state.motionContract.frameCount} 帧`);
  }
  const firstStop = ordered.findIndex(segment => segment.role === 'stop');
  if (firstStop < 0) problems.push(`state ${state.stateId} 声明了片段但缺少 stop 段`);
  else if (!ordered.slice(0, firstStop).some(segment => segment.role === 'loop')) {
    problems.push(`state ${state.stateId} 的 loop 段必须在 stop 段之前`);
  }
  return problems;
}

/** 生成期依赖必须指向真实存在的其它 state，共用起手图的 anchorId 不能撞名。 */
function generationProblems(graph: ActionGraph, statesById: Map<string, ActionState>): string[] {
  const problems: string[] = [];
  const anchors = new Map<string, string>();
  for (const state of graph.states) {
    const generation = state.clipGeneration;
    for (const [label, id] of [['startFrameFromStateId', generation.startFrameFromStateId], ['endFrameFromStateId', generation.endFrameFromStateId]] as const) {
      if (id === null) continue;
      if (id === state.stateId) problems.push(`state ${state.stateId} 的 ${label} 不能指向自身`);
      else if (!statesById.has(id)) problems.push(`state ${state.stateId} 的 ${label} 引用了不存在的 state ${id}`);
    }
    const image = generation.sharedStartImage;
    if (!image) continue;
    const owner = anchors.get(image.anchorId);
    if (owner) problems.push(`sharedStartImage 的 anchorId ${image.anchorId} 被 ${owner} 与 ${state.stateId} 重复使用`);
    else anchors.set(image.anchorId, state.stateId);
  }
  return problems;
}

function transitionProblems(graph: ActionGraph, statesById: Map<string, ActionState>): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const transition of graph.transitions) {
    if (seenIds.has(transition.transitionId)) problems.push(`transition id ${transition.transitionId} 重复`);
    seenIds.add(transition.transitionId);
    const from = statesById.get(transition.fromStateId);
    const to = statesById.get(transition.toStateId);
    if (!from || !to) {
      problems.push(`transition ${transition.transitionId} 的 from/to 不存在`);
      continue;
    }
    outgoing.add(from.stateId);
    incoming.add(to.stateId);
    if (from.terminal) problems.push(`terminal state ${from.stateId} 不能有出边`);
    if (transition.fromEndAnchorId !== from.endAnchor.anchorId) problems.push(`transition ${transition.transitionId} 的 fromEndAnchorId 与来源 state 不匹配`);
    if (transition.toStartAnchorId !== to.startAnchor.anchorId) problems.push(`transition ${transition.transitionId} 的 toStartAnchorId 与目标 state 不匹配`);
    if (!transition.directions.every(direction => from.directionCoverage.includes(direction) && to.directionCoverage.includes(direction))) {
      problems.push(`transition ${transition.transitionId} 的方向未被两端 state 同时覆盖`);
    }
  }
  for (const state of graph.states) {
    if (state.stateId === graph.initialStateId) continue;
    // entry（入场）状态是天然起点：游戏在出生/生成时直接播放它，不需要从默认状态转入。
    // 但它必须有出边，否则就是真正的孤立节点。
    if (state.phase === 'entry' && outgoing.has(state.stateId)) continue;
    if (!incoming.has(state.stateId)) problems.push(`state ${state.stateId} 从初始 state 不可达`);
  }
  return problems;
}
