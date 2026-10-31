/**
 * 生成进度的显示规则（节点进度环与活动面板共用一套）
 * （change: 2026-10-31-unify-node-and-activity-progress，design D1/D2）。
 *
 * 进度有两个来源：
 *
 * 1. **规范上报**：Task 链路持久化的 `progress`（活动面按 0..1 分数承载）；
 * 2. **按种类的时间估算**：Bevy 逐帧用节点种类估算经过时间对应的百分比。
 *
 * 渲染器一直按 `max(估算, 上报)` 显示（`openspec/specs/canvas-runtime` 的进度环要求），
 * 但活动面板原来只显示上报值、且把 0..1 分数直接当成节点要的 0..100 百分比，于是同一个
 * 任务在面板和节点上显示两个不同的数字。这里把规则收成一份纯函数：面板与节点投影都用它
 * 计算同一个整数百分比，Bevy 侧的常量由 `generation_progress.rs` 提供并在测试里保持一致。
 *
 * 纯函数：不读时钟（`now` 由调用方传入），不依赖 DOM/Node/Yjs。
 */

/**
 * 估算进度上限（%）。
 *
 * 运行中不显示 100%：完成由节点离开运行态表达，与 `generation_progress.rs` 的
 * `ESTIMATE_CEILING` 一致。
 */
export const GENERATION_ESTIMATE_CEILING = 95;

/**
 * 各节点种类对应的估算生成时长（秒），与 `generation_progress.rs` 的 `*_SECS` 一致。
 *
 * 只影响动画观感，不影响真实结果：上报进度更高时始终以上报为准。
 */
export const GENERATION_ESTIMATE_SECONDS = {
  text: 15,
  image: 45,
  video: 180,
  audio: 60
} as const;

export type GenerationEstimateCategory = keyof typeof GENERATION_ESTIMATE_SECONDS;

/**
 * 节点类型/任务模型类型 → 估算分类。
 *
 * 画布节点用渲染类型（`image`/`video`/`audio`/`text`/`model`…），任务活动用模型类型
 * （`language` 对应文本节点）。未识别的一律回退图片时长，与 Rust 侧 `_ =>` 分支一致。
 */
const CATEGORY_BY_KIND: Readonly<Record<string, GenerationEstimateCategory>> = {
  text: "text",
  language: "text",
  image: "image",
  video: "video",
  audio: "audio"
};

/** 节点种类/模型类型的估算时长（秒）。 */
export function generationEstimateSeconds(kind: string | undefined): number {
  const category = kind === undefined ? undefined : CATEGORY_BY_KIND[kind];
  return GENERATION_ESTIMATE_SECONDS[category ?? "image"];
}

/** 经过时间 → 估算进度（1..=95 的百分比，单调递增）。 */
export function estimateGenerationPercent(elapsedSeconds: number, kind: string | undefined): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 1;
  const percent = (elapsedSeconds / generationEstimateSeconds(kind)) * 100;
  return Math.min(GENERATION_ESTIMATE_CEILING, Math.max(1, percent));
}

/**
 * 规范上报的 `progress` → 0..100 百分比。
 *
 * 活动面按 0..1 分数承载（Provider 也统一归一成 1 表示完成），但历史里可能夹带已经是百分比的
 * 值；`<= 1` 视为分数，其余按百分比理解，最后夹到 0..100。缺失或非法返回 `undefined`
 * （绝不伪造）。
 */
export function reportedProgressPercent(progress: number | undefined): number | undefined {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return undefined;
  const percent = progress <= 1 ? progress * 100 : progress;
  return Math.min(100, Math.max(0, percent));
}

/**
 * 运行中任务的显示百分比 = `max(按种类估算, 规范上报)`，夹在 1..=95。
 *
 * `startedAt` 缺失或非法（例如只有乐观记录、没有创建时间）时不估算，只用上报值；两者都缺失
 * 时返回下限 1。调用方负责只在非终态使用它。
 */
export function displayGenerationPercent(input: {
  /** 该运行开始的时刻（ISO）；通常是画布节点 busy 或活动记录创建的同一时刻。 */
  startedAt?: string;
  /** 规范上报进度（0..1 分数或 0..100 百分比）。 */
  reported?: number;
  /** 节点种类或任务模型类型。 */
  kind?: string;
  /** 当前时刻（毫秒时间戳），由调用方传入以保证可测。 */
  now: number;
}): number {
  const started = input.startedAt === undefined ? Number.NaN : Date.parse(input.startedAt);
  const elapsedSeconds = Number.isFinite(started) ? Math.max(0, (input.now - started) / 1000) : 0;
  const estimate = Number.isFinite(started) ? estimateGenerationPercent(elapsedSeconds, input.kind) : 1;
  const reported = reportedProgressPercent(input.reported) ?? 1;
  return Math.max(estimate, Math.min(GENERATION_ESTIMATE_CEILING, Math.max(1, reported)));
}

/** 显示用的整数百分比（面板文案与节点标签取同一舍入）。 */
export function roundedGenerationPercent(input: Parameters<typeof displayGenerationPercent>[0]): number {
  return Math.round(displayGenerationPercent(input));
}
