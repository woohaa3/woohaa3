import { z } from 'zod';
import { BlockedError, ValidationError } from './errors';
import { DIRECTION_IDS, GENERATION_ORDER, MIRROR_POLICY, type DirectionId, type DirectionPolicyEntry } from './ids';
import { zDirectionId } from './zod-helpers';

export const mirrorSafetySchema = z
  .object({
    safe: z.boolean(),
    asymmetricFeatures: z.array(z.string().min(1).max(200)).max(40),
    handednessConstraints: z.array(z.string().min(1).max(200)).max(40),
    textOrSymbolsPresent: z.boolean(),
    userAcceptedSemanticMirroring: z.boolean(),
  })
  .strict();
export type MirrorSafety = z.infer<typeof mirrorSafetySchema>;

export const mirrorEntrySchema = z
  .object({ direction: zDirectionId, source: zDirectionId, transform: z.literal('hflip') })
  .strict();

export const policyEntrySchema = z.union([
  z.object({ kind: z.literal('master') }).strict(),
  z.object({ kind: z.literal('mirror'), source: zDirectionId, transform: z.literal('hflip') }).strict(),
]);

function fullPolicySchema() {
  const shape = {} as Record<DirectionId, typeof policyEntrySchema>;
  for (const direction of DIRECTION_IDS) shape[direction] = policyEntrySchema;
  return z.object(shape).strict();
}

export const directionPlanSchema = z
  .object({
    schema: z.literal('project-a.creature-video-direction-plan.v1'),
    selectedDirections: z.array(zDirectionId).min(1).max(8),
    generationDirections: z.array(zDirectionId).min(1).max(8),
    masters: z.array(zDirectionId).min(1).max(8),
    mirrors: z.array(mirrorEntrySchema).max(8),
    policy: fullPolicySchema(),
    mirrorSafety: mirrorSafetySchema,
    mirrorDecision: z.enum(['accepted_semantic_mirroring', 'promoted_all_to_master']).nullable(),
  })
  .strict();
export type DirectionPlan = z.infer<typeof directionPlanSchema>;

export type MirrorDecision = 'accepted_semantic_mirroring' | 'promoted_all_to_master';

export interface PlanDirectionsOptions {
  mirrorSafety: MirrorSafety;
  mirrorDecision?: MirrorDecision | null;
}

/**
 * 解析逻辑方向到母版的映射。默认 8 logical = 5 master + 3 mirror；
 * 子集规划先解析链再检测镜像链/循环，因此 mirror 的 source 必须是 master。
 */
export function planDirections(selected: readonly string[], options: PlanDirectionsOptions): DirectionPlan {
  const requested = normalizeSelection(selected);
  const hasMirrorRequest = requested.some(direction => resolveMaster(direction).kind === 'mirror');
  const mirrorDecision = resolveMirrorDecision(options, requested, hasMirrorRequest);
  const policy = buildPolicy(mirrorDecision);
  const masters = uniqueSorted(
    requested.map(direction => masterOf(direction, policy)),
  );
  return directionPlanSchema.parse({
    schema: 'project-a.creature-video-direction-plan.v1',
    selectedDirections: requested,
    generationDirections: masters,
    masters,
    mirrors: requested
      .filter(direction => policy[direction].kind === 'mirror')
      .map(direction => {
        const entry = policy[direction] as Extract<DirectionPolicyEntry, { kind: 'mirror' }>;
        return { direction, source: entry.source, transform: entry.transform };
      }),
    policy: Object.fromEntries(DIRECTION_IDS.map(direction => [direction, policy[direction]])),
    mirrorSafety: {
      ...options.mirrorSafety,
      userAcceptedSemanticMirroring: mirrorDecision === 'accepted_semantic_mirroring',
    },
    mirrorDecision,
  });
}

export function mirrorSourceOf(plan: DirectionPlan, direction: DirectionId): DirectionId | null {
  return plan.policy[direction]?.kind === 'mirror' ? (plan.policy[direction] as { source: DirectionId }).source : null;
}

export function masterOf(direction: DirectionId, policy: Record<DirectionId, DirectionPolicyEntry>): DirectionId {
  const entry = policy[direction];
  if (!entry) throw new ValidationError(`未知方向 ${direction}`);
  return entry.kind === 'master' ? direction : entry.source;
}

function normalizeSelection(selected: readonly string[]): DirectionId[] {
  if (!Array.isArray(selected) || selected.length === 0) throw new ValidationError('selectedDirections 不能为空');
  const unique = new Set<DirectionId>();
  for (const value of selected) {
    if (!(DIRECTION_IDS as readonly string[]).includes(value)) throw new ValidationError(`未知方向 ${String(value)}`);
    unique.add(value as DirectionId);
  }
  return uniqueSorted([...unique]);
}

function uniqueSorted(directions: readonly DirectionId[]): DirectionId[] {
  const order = new Map<DirectionId, number>(GENERATION_ORDER.map((direction, index) => [direction, index]));
  return [...new Set(directions)].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

function resolveMaster(direction: DirectionId): DirectionPolicyEntry {
  const entry = MIRROR_POLICY[direction];
  if (!entry) throw new ValidationError(`未知方向 ${direction}`);
  if (entry.kind === 'master') return entry;
  const upstream = MIRROR_POLICY[entry.source];
  if (!upstream) throw new ValidationError(`方向 ${direction} 的镜像来源 ${entry.source} 不存在`);
  if (upstream.kind !== 'master') {
    throw new ValidationError(`方向 ${direction} 形成镜像链或镜像循环，P0 只支持单级镜像 master -> mirror`);
  }
  return entry;
}

function resolveMirrorDecision(
  options: PlanDirectionsOptions,
  requested: readonly DirectionId[],
  hasMirrorRequest: boolean,
): MirrorDecision | null {
  if (!hasMirrorRequest) return null;
  if (options.mirrorSafety.safe) return 'accepted_semantic_mirroring';
  if (options.mirrorDecision === 'accepted_semantic_mirroring' || options.mirrorDecision === 'promoted_all_to_master') {
    return options.mirrorDecision;
  }
  throw new BlockedError(
    `镜像安全为 false，方向 ${requested.join(', ')} 不能静默镜像：请明确接受左右互换，或把这些方向提升为独立母版并增加付费任务。`,
    { requestedDirections: requested },
  );
}

function buildPolicy(mirrorDecision: MirrorDecision | null): Record<DirectionId, DirectionPolicyEntry> {
  const entry: Record<DirectionId, DirectionPolicyEntry> = { ...MIRROR_POLICY };
  if (mirrorDecision !== 'promoted_all_to_master') return entry;
  for (const direction of DIRECTION_IDS) entry[direction] = { kind: 'master' };
  return entry;
}
