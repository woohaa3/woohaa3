/**
 * ChatGPT 生成编排：类型与请求身份
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import type { ChatGptGenerateRequest, ChatGptGenerationMode, ChatGptGenerationReceipt } from "@woohaa3/contracts";

export type GenerateRequest = ChatGptGenerateRequest & {
  ownerId: string;
  /** 宿主准备的规范角色回合（host-only；浏览器请求只带 roleId）。 */
  prepared: import("@woohaa3/contracts").PreparedAgentRoleTurn;
};

export type GenerationProgress = (event: {
  requestId: string; stage: string; detail?: string;
  message?: string;
  tool?: { name: string; callId?: string; status: "started" | "completed" | "failed"; ok?: boolean; summary?: string };
}) => void;

export type GenerationOutcome =
  | { ok: true; receipt: ChatGptGenerationReceipt }
  | { ok: false; status: number; code: string; message: string };

export type RequestRecord = {
  requestId: string;
  /** 输入身份（用于同 requestId 不一致输入拒绝）。 */
  identity: string;
  mode: ChatGptGenerationMode;
  receipt: ChatGptGenerationReceipt;
  llmOutput?: string;
  clipId?: string; itemId?: string;
};

export function identityOf(input: GenerateRequest): string {
  return JSON.stringify({
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    mode: input.mode,
    model: input.model,
    prompt: input.prompt,
    expectedContentHash: input.expectedContentHash ?? null,
    preparedHash: input.prepared?.preparedHash ?? null,
    selectedCameraId: input.selectedCameraId ?? null,
    clipId: input.clipId ?? null,
    itemId: input.itemId ?? null,
    // 默认请求保持原身份，兼容已有持久化回执；显式强度参与幂等校验。
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort })
  });
}
