/**
 * prompt-skills 扩展共享定义（前后端都能导入；不含网络或 Node 实现）。
 *
 * 扩展把执行面板的「快捷改写」接到站点语言模型：前端只声明 slot 贡献与请求协议，
 * 后端用宿主注入的 Task facade 提交一次非画布文本任务并取回改写结果。
 */

import { containsWoohaa3CanvasMentionToken } from "@woohaa3/contracts";

export const PROMPT_SKILLS_PLUGIN_ID = "prompt-skills";

/** 公开映射：`/api/prompt-skills/*` → 本插件的受控 JSON handler。 */
export const PROMPT_SKILLS_PUBLIC_BASE_PATH = "/api/prompt-skills";

/** 一次改写的任务类型：始终是语言模型（与画布节点类型无关）。 */
export const PROMPT_SKILLS_MODEL_TYPE = "language";

/** 草稿上限低于 Task 的 8000 字上限，给模板与系统提示词留出空间。 */
export const PROMPT_SKILLS_MAX_PROMPT_CHARS = 6000;

export type PromptSkillRewriteRequest = {
  /** 前端每次触发生成的稳定幂等身份；重试复用同一 id。 */
  requestId: string;
  skillId: string;
  label: string;
  prompt: string;
  canvasId: string;
  nodeId: string;
  taskKind: string;
};

/** 插件设置读模型：改写模型只属于扩展配置，执行面板不再提供模型选择。 */
export type PromptSkillConfigResponse =
  | { ok: true; model: string; revision: number | null }
  | { ok: false; error: string };

/** 插件设置写请求：CAS 用读取时的 revision；`null` 表示“应不存在”。 */
export type PromptSkillConfigWriteRequest = {
  model: string;
  expectedRevision: number | null;
};

export type PromptSkillRewriteResponse =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown, maxLength = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/**
 * 解码一次改写请求。
 *
 * 只接受前端最小必要字段：技能身份用于选择模板，`modelKey` 由 Task facade 再按目录
 * 校验（这里不做模型白名单，避免扩展复制宿主的路由规则）。
 */
export function decodePromptSkillRewriteRequest(value: unknown): DecodeResult<PromptSkillRewriteRequest> {
  if (!isRecord(value)) return { ok: false, error: "请求体必须是 JSON 对象" };
  const requestId = value.requestId;
  if (!isBoundedId(requestId, 120)) return { ok: false, error: "requestId 必须是非空字符串" };
  const skillId = value.skillId;
  if (!isBoundedId(skillId, 64)) return { ok: false, error: "skillId 必须是非空字符串" };
  const prompt = value.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") return { ok: false, error: "请先输入提示词" };
  if (prompt.length > PROMPT_SKILLS_MAX_PROMPT_CHARS) {
    return { ok: false, error: `提示词超过 ${PROMPT_SKILLS_MAX_PROMPT_CHARS} 字，请先精简后再改写` };
  }
  // 参考素材在草稿里是 `{{input_image:...}}` 形态的规范 token；Task 拒绝含 token 的提示词，
  // 而静默剥掉 token 会让改写结果丢失参考绑定，所以这里明确拒绝。
  if (containsWoohaa3CanvasMentionToken(prompt)) {
    return { ok: false, error: "草稿里包含参考素材标记，暂不支持一键改写；请先复制文字改写后再粘贴" };
  }
  const optionalText = (input: unknown, fallback = ""): string => (typeof input === "string" ? input : fallback);
  return {
    ok: true,
    value: {
      requestId,
      skillId,
      label: optionalText(value.label, skillId),
      prompt,
      canvasId: optionalText(value.canvasId),
      nodeId: optionalText(value.nodeId),
      taskKind: optionalText(value.taskKind)
    }
  };
}

/** 清理模型输出：去掉代码围栏、常见前缀与包裹引号，只保留提示词正文。 */
export function cleanRewrittenPrompt(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^(改写后的提示词|改写后|润色后的提示词|润色后|结果|输出)\s*[:：]\s*/, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”")) ||
    (text.startsWith("「") && text.endsWith("」"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}
