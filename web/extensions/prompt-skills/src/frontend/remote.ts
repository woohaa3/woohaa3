/**
 * 快捷改写的浏览器出口。
 *
 * 只经宿主注入的 `ApplicationRemoteTransport` 访问 `/api/prompt-skills/rewrite`；
 * 扩展不直接 fetch、不持有凭据，也不解释模型路由。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import {
  PROMPT_SKILLS_PUBLIC_BASE_PATH,
  type PromptSkillRewriteRequest,
  type PromptSkillRewriteResponse
} from "../shared.js";

export type PromptSkillsRewriteInput = Omit<PromptSkillRewriteRequest, "requestId"> & { requestId?: string };

export type PromptSkillsRemoteResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

export type PromptSkillsRemote = {
  rewrite(input: PromptSkillRewriteRequest): Promise<PromptSkillsRemoteResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readResponse(data: unknown): PromptSkillsRemoteResult {
  if (!isRecord(data)) return { ok: false, error: "改写响应无法识别" };
  const decoded = data as Partial<PromptSkillRewriteResponse>;
  if (decoded.ok === true && typeof decoded.prompt === "string" && decoded.prompt.trim() !== "") {
    return { ok: true, prompt: decoded.prompt };
  }
  if (decoded.ok === false && typeof decoded.error === "string" && decoded.error.trim() !== "") {
    return { ok: false, error: decoded.error };
  }
  return { ok: false, error: "改写响应无法识别" };
}

export function createPromptSkillsRemote(options: {
  transport: ApplicationRemoteTransport;
  basePath?: string;
}): PromptSkillsRemote {
  const basePath = (options.basePath ?? PROMPT_SKILLS_PUBLIC_BASE_PATH).replace(/\/$/, "");
  return {
    async rewrite(input) {
      const result = await options.transport.request({
        path: `${basePath}/rewrite`,
        method: "POST",
        body: input
      });
      if (!result.ok) {
        return { ok: false, error: result.error.trim() !== "" ? result.error : "改写请求失败" };
      }
      return readResponse(result.data);
    }
  };
}
