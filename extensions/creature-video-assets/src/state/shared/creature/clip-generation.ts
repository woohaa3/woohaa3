import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/);

/**
 * clip 生成期的差异化处理。
 *
 * 这里只描述「这条 clip 怎么串进动作链」与「提示词要额外强调什么」，
 * 具体生物的语义（卵、八足步态、爆裂节奏…）一律由动作设计作者写进字段，
 * 生成代码不再内置任何物种判断。所有字段都有默认值，缺省即通用行为：
 * 循环动作用站定图起手、裁到设计帧数、不替换末帧。
 */
export const clipGenerationSchema = z
  .object({
    /** 非循环动作的起手画面取同一方向指定 state clip 的末帧；null 表示沿用该方向的站定图。 */
    startFrameFromStateId: identifier.nullable().default(null),
    /** 末帧硬替换成同一方向指定 state clip 的首帧，两段因此共用同一张图；null 表示不替换。 */
    endFrameFromStateId: identifier.nullable().default(null),
    /**
     * 起手画面不由任何已有 clip 提供，而是单独生成一张所有方向共用的图。
     * 共用一张的前提是主体各向同性，所以提示词不带方向要求。
     */
    sharedStartImage: z
      .object({
        anchorId: identifier,
        identity: z.string().min(1).max(400),
        action: z.string().min(1).max(600),
        invariants: z.array(z.string().min(1).max(200)).max(8).default([]),
      })
      .nullable()
      .default(null),
    /** 模型演得比设计时长更慢时：keep_full 整段压缩保留全部动作帧，而不是把后半段裁掉。 */
    timeline: z
      .object({
        mode: z.enum(['trim', 'keep_full']).default('trim'),
        /** keep_full 时保留的成片秒数；null 表示用设计时长。 */
        seconds: z.number().positive().max(30).nullable().default(null),
      })
      .default({ mode: 'trim', seconds: null }),
    /** 追加到提示词的不变式：步态、爆裂节奏等按物种由动作设计作者声明。 */
    promptInvariants: z.array(z.string().min(1).max(400)).max(16).default([]),
  })
  .strict();

/** 通用行为：站定图起手、裁到设计帧数、不替换末帧、不追加物种措辞。 */
export const DEFAULT_CLIP_GENERATION = {
  startFrameFromStateId: null,
  endFrameFromStateId: null,
  sharedStartImage: null,
  timeline: { mode: 'trim', seconds: null },
  promptInvariants: [],
} satisfies z.input<typeof clipGenerationSchema>;

export const clipGenerationWithDefaults = clipGenerationSchema.default(DEFAULT_CLIP_GENERATION);
export type ClipGeneration = z.infer<typeof clipGenerationWithDefaults>;
