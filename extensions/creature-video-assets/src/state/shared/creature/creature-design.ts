import { z } from 'zod';
import { mirrorSafetySchema } from './direction';

export const BACKGROUND_KINDS = ['green_screen', 'blue_screen', 'gray_plate', 'neutral_generated', 'natural', 'unknown'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];

export const actionCandidateSchema = z
  .object({
    stateId: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    displayName: z.string().min(1).max(80),
    kind: z.enum(['loop', 'one_shot']),
    phase: z.enum(['idle', 'entry', 'loop', 'exit', 'one_shot', 'terminal']),
    durationSeconds: z.number().positive().max(100),
    description: z.string().min(1).max(600),
    required: z.boolean(),
    userRequested: z.boolean(),
  })
  .strict();

export const creatureDesignSchema = z
  .object({
    schema: z.literal('project-a.creature-video-creature-design.v1'),
    displayName: z.string().min(1).max(80),
    summary: z.string().min(1).max(1200),
    anatomy: z.array(z.string().min(1).max(300)).min(1).max(32),
    locomotion: z.string().min(1).max(600),
    materials: z.array(z.string().min(1).max(200)).min(1).max(24),
    palette: z.array(z.string().min(1).max(120)).min(1).max(24),
    signatureFeatures: z.array(z.string().min(1).max(200)).min(1).max(24),
    scaleMeters: z.number().positive().max(1000),
    footBaselineNote: z.string().min(1).max(400),
    backgroundKind: z.enum(BACKGROUND_KINDS),
    forbiddenChanges: z.array(z.string().min(1).max(300)).min(1).max(24),
    mirrorSafety: mirrorSafetySchema,
    actionCandidates: z.array(actionCandidateSchema).min(1).max(24),
    promptInvariants: z.array(z.string().min(1).max(400)).min(1).max(32),
    userRequest: z.string().min(1).max(4000),
  })
  .strict();
export type CreatureDesign = z.infer<typeof creatureDesignSchema>;

export function identityPromptLayer(design: CreatureDesign): string {
  return [
    `主体是同一只${design.displayName}：${design.summary}`,
    `解剖：${design.anatomy.join('；')}。`,
    `运动方式：${design.locomotion}。`,
    `材质与颜色：${[...design.materials, ...design.palette].join('；')}。`,
    `识别特征（必须逐帧保持）：${design.signatureFeatures.join('；')}。`,
    `尺度约 ${design.scaleMeters} 米，脚底语义：${design.footBaselineNote}。`,
    `禁止变化：${design.forbiddenChanges.join('；')}。`,
    ...design.promptInvariants,
  ].join('\n');
}

export function backgroundPromptLayer(backgroundKind: BackgroundKind): string {
  switch (backgroundKind) {
    case 'green_screen':
      return '纯绿色幕布背景，颜色均匀，主体边缘不出现绿色溢色或绿色描边。';
    case 'blue_screen':
      return '纯蓝色幕布背景，颜色均匀，主体边缘不出现蓝色溢色或蓝色描边。';
    case 'gray_plate':
      return '均匀灰白棚拍背景，光照平坦，背景近似静态，便于按 plate 反解软边。';
    case 'neutral_generated':
      return '中性生成的单色背景，与主体颜色差异明显，便于抠像且不污染主体边缘。';
    case 'natural':
      return '自然纹理背景，但主体周围保留清晰轮廓，不与背景颜色接近。';
    default:
      return '干净的单色或简单纹理背景，色相与主体明显区分，不做绿蓝溢色处理。';
  }
}
