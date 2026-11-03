/**
 * 一次提示词改写的任务编排（扩展后端，进程内）。
 *
 * 复用宿主既有的**非画布插件任务**通路：扩展不能碰 Provider 凭据或画布 run，只能提交
 * 自己拥有的文本任务、轮询状态并读取完整结果。结果文本写回草稿由前端 Host 负责。
 */
import type { ApplicationExtensionTaskFacade } from "@woohaa3/contracts";
import {
  cleanRewrittenPrompt,
  PROMPT_SKILLS_MODEL_TYPE,
  type PromptSkillRewriteRequest
} from "../shared.js";
import { buildRewriteInput } from "./prompts.js";

export type PromptSkillRewriteDeps = {
  tasks: ApplicationExtensionTaskFacade;
  logger?: (event: Record<string, unknown>) => void;
  /** 单次改写等待上限；超时取消任务并返回可操作错误。 */
  timeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PromptSkillRewriteResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string; status: number };

/** 后端解析出配置模型后的执行输入：模型不在前端请求里。 */
export type PromptSkillRewriteInput = PromptSkillRewriteRequest & { modelKey: string };

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 400;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function submitFailure(code: string, message: string): PromptSkillRewriteResult {
  const safeMessage = message.trim();
  switch (code) {
    case "unauthorized":
      return { ok: false, status: 401, error: "没有权限使用快捷改写" };
    case "unavailable":
      return { ok: false, status: 503, error: "改写服务暂不可用，请检查模型目录或 Provider 配置" };
    case "unsupported":
      return { ok: false, status: 400, error: "当前模型不支持文本改写，请换一个语言模型" };
    case "key-reused":
      return { ok: false, status: 409, error: "同一请求被用于不同内容，请重新触发改写" };
    case "storage-failed":
      return { ok: false, status: 502, error: "改写任务保存失败，请稍后重试" };
    default:
      return { ok: false, status: 502, error: safeMessage !== "" ? safeMessage : "改写任务提交失败" };
  }
}

/** 提交一次文本任务并等待终态；只在成功时返回清理后的提示词。 */
export async function rewritePromptWithTask(
  request: PromptSkillRewriteInput,
  deps: PromptSkillRewriteDeps
): Promise<PromptSkillRewriteResult> {
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? sleep;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = deps.logger ?? (() => undefined);
  const workerTaskKey = `prompt-skills-${request.requestId}`;
  const input = buildRewriteInput(request);

  const submitted = await deps.tasks.submit({
    workerTaskKey,
    modelType: PROMPT_SKILLS_MODEL_TYPE,
    modelKey: request.modelKey,
    prompt: input.prompt,
    // 系统提示词走 Provider 的独立字段；`maxTokens` 与目录 defaultInput 同名。
    parameters: { system: input.system, maxTokens: 1600 }
  });
  if (!submitted.ok) {
    log({ event: "prompt-skills-submit-rejected", code: submitted.code });
    return submitFailure(submitted.code, submitted.message);
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await deps.tasks.status(workerTaskKey);
    if (!status) return { ok: false, status: 502, error: "改写任务丢失，请重试" };
    if (status.state === "succeeded") break;
    if (TERMINAL_STATES.has(status.state)) {
      const detail = await deps.tasks.result?.(workerTaskKey);
      const reason = detail?.error?.message?.trim();
      const fallback = status.state === "cancelled" ? "改写已取消" : "改写失败";
      log({ event: "prompt-skills-task-terminal", state: status.state });
      return { ok: false, status: 502, error: reason && reason !== "" ? reason : fallback };
    }
    if (now() >= deadline) {
      await deps.tasks.cancel?.(workerTaskKey).catch(() => undefined);
      log({ event: "prompt-skills-task-timeout", timeoutMs });
      return { ok: false, status: 504, error: "改写超时，请稍后重试或换一个更快的模型" };
    }
    await wait(pollIntervalMs);
  }

  const detail = await deps.tasks.result?.(workerTaskKey);
  const text = detail?.result?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, status: 502, error: "模型没有返回改写后的文本" };
  }
  const prompt = cleanRewrittenPrompt(text);
  if (prompt === "") return { ok: false, status: 502, error: "模型返回了空结果，草稿未修改" };
  log({ event: "prompt-skills-rewrite-succeeded" });
  return { ok: true, prompt };
}
