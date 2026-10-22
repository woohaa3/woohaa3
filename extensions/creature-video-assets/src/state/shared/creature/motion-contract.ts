import { z } from 'zod';
import { ValidationError } from './errors';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/);

export const motionEventSchema = z
  .object({
    id: identifier,
    frame: z.number().int().nonnegative(),
    instruction: z.string().min(1).max(400),
  })
  .strict();

export const repeatGroupSchema = z
  .object({
    id: identifier,
    repeatCount: z.number().int().min(1).max(64),
    sequence: z.array(identifier).min(1).max(32),
  })
  .strict();

export const symmetryPairSchema = z
  .object({
    leftEvent: identifier,
    rightEvent: identifier,
    property: z.string().min(1).max(120),
    toleranceFrames: z.number().int().min(0).max(24),
  })
  .strict();

export const motionContractSchema = z
  .object({
    schema: z.literal('motion-contract.v1'),
    fps: z.literal(24),
    frameCount: z.number().int().positive().max(2400),
    rhythmToleranceFrames: z.number().int().min(0).max(24),
    events: z.array(motionEventSchema).min(2).max(64),
    repeatGroups: z.array(repeatGroupSchema).max(16),
    symmetryPairs: z.array(symmetryPairSchema).max(16),
  })
  .strict();
export type MotionContract = z.infer<typeof motionContractSchema>;
export type MotionEvent = z.infer<typeof motionEventSchema>;

const SCREEN_LATERALITY = /屏幕\s*(左|右)|screen[\s_-]*(left|right)/i;

/** 自然语言时序不能作为唯一验收依据；这里把结构问题一次性报出。 */
export function assertValidMotionContract(contract: MotionContract): void {
  const problems: string[] = [];
  const ids = contract.events.map(event => event.id);
  if (new Set(ids).size !== ids.length) problems.push('event id 必须唯一');
  const frames = contract.events.map(event => event.frame);
  if (frames.some((frame, index) => index > 0 && frame <= frames[index - 1])) problems.push('event 帧号必须严格递增');
  if (frames.some(frame => frame >= contract.frameCount)) problems.push(`event 帧号必须小于 frameCount ${contract.frameCount}`);
  if (frames[0] !== 0) problems.push('首帧必须有事件');
  if (frames[frames.length - 1] !== contract.frameCount - 1) problems.push('末帧必须有事件');
  const known = new Set(ids);
  for (const group of contract.repeatGroups) {
    const missing = group.sequence.filter(id => !known.has(id));
    if (missing.length) problems.push(`repeatGroup ${group.id} 引用不存在的 event：${missing.join(', ')}`);
    if (group.sequence.length * group.repeatCount > contract.frameCount) problems.push(`repeatGroup ${group.id} 重复次数超出帧数`);
  }
  for (const pair of contract.symmetryPairs) {
    for (const id of [pair.leftEvent, pair.rightEvent]) if (!known.has(id)) problems.push(`symmetryPair 引用不存在的 event ${id}`);
  }
  for (const event of contract.events) {
    if (SCREEN_LATERALITY.test(event.instruction)) {
      problems.push(`event ${event.id} 用屏幕左右描述身体左右，必须改写为解剖左右`);
    }
  }
  if (problems.length) throw new ValidationError(`motion contract 校验失败：${problems.join('；')}`, { problems });
}
