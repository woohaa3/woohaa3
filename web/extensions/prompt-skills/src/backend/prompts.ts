/**
 * 快捷改写的提示词模板（纯函数，无 I/O）。
 *
 * 每个技能只提供本任务的指令与系统提示词。指令同时写进 `system` 与用户消息：
 * 有些 Provider（例如经远端服务转发的语言模型）会忽略 `system` 字段，只把用户消息交给
 * 模型；只依赖 system 时模型会自由创作而不是改写提示词。用户草稿始终放在独立段落，
 * 并明确要求"只输出改写后的提示词正文"。
 */
import type { PromptSkillRewriteRequest } from "../shared.js";

export type PromptSkillTemplate = {
  /** 模型温度/输出长度等不在此处声明：跟随站点语言模型默认值。 */
  system: string;
  instruction: string;
};

const COMMON_SYSTEM = [
  "你是资深的 AI 图像与视频提示词编辑。",
  "只输出改写后的提示词正文：不要解释、不要前言、不要引号、不要 Markdown 代码块。",
  "保留原文里的具体设定（模型名、参数、数字、专有名词、参考素材说明），不要编造新的主体或情节。",
  "如果原文已经是目标语言或已经足够好，也请做最小必要润色而不是拒绝。"
].join("");

export const PROMPT_SKILL_TEMPLATES: Readonly<Record<string, PromptSkillTemplate>> = {
  "universal-polish": {
    system: COMMON_SYSTEM,
    instruction: "把用户的提示词改写得更清晰、更有表现力，补全影响生成结果的关键细节；保持原有意图与全部具体设定。"
  },
  polish: {
    system: COMMON_SYSTEM,
    instruction: "补足主体、构图、镜头、光影与氛围等视觉细节，让提示词更完整；不要改变原意或替换主体。"
  },
  translate: {
    system: COMMON_SYSTEM,
    instruction: "在中文与英文之间做等价翻译：中文改写为英文、英文改写为中文；保留参数、模型名与视觉关键词的准确含义。"
  },
  structure: {
    system: COMMON_SYSTEM,
    instruction: "把提示词按主体、场景、镜头、光影、风格分层整理成简洁的分段文本；只重排与合并原文信息，不新增设定。"
  },
  "style-transfer": {
    system: COMMON_SYSTEM,
    instruction: "保留主体与构图，把提示词整体迁移为一种统一的视觉风格：优先采用原文已点明的风格，原文没有时采用协调的电影感写实风格。"
  },
  "loop-frame": {
    system: COMMON_SYSTEM,
    instruction: "把提示词改写为可无缝循环的低频动态视频提示词：明确主体运动、镜头运动与循环条件，避免快速切换与场景跳变。"
  }
};

/** 未登记的技能 id 使用通用润色模板，避免扩展升级前新增技能时直接失败。 */
export function resolvePromptSkillTemplate(skillId: string): PromptSkillTemplate {
  return PROMPT_SKILL_TEMPLATES[skillId] ?? PROMPT_SKILL_TEMPLATES["universal-polish"]!;
}

/**
 * 组装交给语言模型的输入。
 *
 * `system` 给支持的 Provider；`prompt` 里再带一次任务与输出约束，兼容忽略 system 的实现。
 * 用户草稿放在 `待改写提示词：` 后的独立段落，且不作为指令执行。
 */
export function buildRewriteInput(
  request: Pick<PromptSkillRewriteRequest, "skillId" | "prompt" | "taskKind">
): { system: string; prompt: string } {
  const template = resolvePromptSkillTemplate(request.skillId);
  const context = request.taskKind.startsWith("video") ? "当前目标是视频生成。" : "当前目标是图像生成。";
  const system = `${template.system}\n${context}\n任务：${template.instruction}`;
  const prompt = [
    `任务：${template.instruction}`,
    context,
    "只输出改写后的提示词正文：不要解释、不要写诗或故事、不要添加原文没有的主体或情节。",
    "",
    "待改写提示词：",
    request.prompt
  ].join("\n");
  return { system, prompt };
}
