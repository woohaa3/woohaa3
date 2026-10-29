/**
 * Skill 步骤请求指纹与提示词规范化
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.2）。
 */
import { createHash } from "node:crypto";

const MAX_PROMPT_CHARS = 20_000;

export function requestHashOf(input: {
  skillRunId: string;
  stepId: string;
  nodeId: string;
  prompt: string;
  modelKey?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.skillRunId, input.stepId, input.nodeId, input.prompt, input.modelKey ?? ""]))
    .digest("hex");
}

export function promptHashOf(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function boundedPrompt(prompt: string | undefined): string {
  return (prompt ?? "").slice(0, MAX_PROMPT_CHARS);
}
