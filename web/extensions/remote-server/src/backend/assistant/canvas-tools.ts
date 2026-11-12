/**
 * 把宿主的画布工具接成远端助手可用的通道。
 *
 * 一次回合的完整链路：
 *   签发 grant（宿主受控）→ 连本机 MCP → 列工具 → 模型调工具 → 执行 → 撤销 grant
 *
 * 为什么必须走 grant 而不是直接调 MCP：
 * 工具网关按 grant 判定"这一轮允许改哪张画布的哪些工具"。绕过它等于让模型拿到一张
 * 不受目标约束的通行证——那是整个助手权限模型的根基。
 *
 * 为什么在宿主进程内连回环 MCP：MCP 端点只接受回环来源，且 grant 不落浏览器。这与
 * 画布同步、存储字节的边界一致。
 */
import type { AgentAdapterRunInput, ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import { createMcpToolClient, type McpToolClient } from "./tool-client.js";
import type { RemoteToolChannel } from "./index.js";
import type { RemoteToolDefinition } from "./chat-client.js";

export type CanvasToolChannelOptions = {
  /** 宿主工具授权面（`ctx.services.authoring.tools`）。 */
  tools: ApplicationToolDelegationFacade;
  /** MCP 端点（宿主本机回环）。 */
  endpoint: string;
  fetchImpl: typeof globalThis.fetch;
  /** 日志出口（不含凭据）。 */
  log?: (event: Record<string, unknown>) => void;
};

/**
 * 为本轮创建工具通道。
 *
 * 返回 null 表示**这一轮不该开工具**：宿主没准备工具集（`prepared.tools` 为空）、
 * 模式不需要写、或缺少目标身份。这时调用方应当只做讨论，而不是给一个空通道让模型
 * 反复失败。
 */
export async function createCanvasToolChannel(
  input: AgentAdapterRunInput,
  options: CanvasToolChannelOptions
): Promise<RemoteToolChannel | null> {
  const prepared = input.prepared;
  const nodeId = input.intent.nodeId;
  // 没有目标节点就没有可写的东西：世界模式的 scope 由 worldScope 表达，仍需 nodeId
  // 作为 scope 载体（宿主签发 grant 时要求它）。
  if (!prepared || prepared.tools.length === 0 || !nodeId) return null;

  const grant = await options.tools.issue({
    delegation: { subject: input.owner, authLevel: "authenticated" },
    workId: input.requestId,
    canvasId: input.canvasId,
    nodeId,
    ...(input.intent.mode ? { mode: input.intent.mode } : {}),
    ...(input.intent.worldScope ? { worldScope: input.intent.worldScope } : {}),
    tools: prepared.tools,
    ...(input.connection ? { credentialEpoch: input.connection.credentialEpoch } : {}),
  });

  const client: McpToolClient = createMcpToolClient({
    endpoint: options.endpoint,
    grant: grant.token,
    allowedTools: prepared.tools,
    fetchImpl: options.fetchImpl,
  });

  let closed = false;
  const receipts: Array<{ canvasId: string; nodeId?: string; commandId: string; revision?: number }> = [];

  return {
    async listTools(): Promise<readonly RemoteToolDefinition[]> {
      try {
        return await client.listTools();
      } catch (error) {
        // 列出失败不该让整轮崩掉：没有工具声明时模型会正常回答，只是改不了东西。
        options.log?.({
          event: "remote-assistant-tool-discovery-failed",
          reason: error instanceof Error ? error.message : "unknown",
        });
        return [];
      }
    },

    async callTool(name, args) {
      const outcome = await client.callTool(name, args);
      // 写入回执是"改动真的落地了"的唯一凭据：模型的自我陈述不可信。
      // 通道这里只收工具自己带回的 commandId；宿主写入成功时 structuredContent 里会有。
      const receipt = readReceipt(outcome.content);
      if (receipt !== null) receipts.push(receipt);
      return outcome;
    },

    async close() {
      if (closed) return;
      closed = true;
      client.dispose();
      // grant 必须撤销：漏了它会让一次已结束的回合仍然持有可写能力。
      options.tools.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" });
    },

    receipts: () => receipts,
  };
}

/**
 * 从工具返回内容里读写入回执。
 *
 * 工具的 structuredContent 是 JSON 串（见 `tool-client` 的 `successText`）；只有带
 * `commandId` 与 `canvasId` 的才算回执——`ok: true` 而没有命令 id 说明那次调用没有
 * 产生持久写入（例如只读工具）。
 */
function readReceipt(content: string): { canvasId: string; nodeId?: string; commandId: string; revision?: number } | null {
  const text = content.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.commandId !== "string" || typeof parsed.canvasId !== "string") return null;
    return {
      canvasId: parsed.canvasId,
      commandId: parsed.commandId,
      ...(typeof parsed.nodeId === "string" ? { nodeId: parsed.nodeId } : {}),
      ...(typeof parsed.revision === "number" ? { revision: parsed.revision } : {}),
    };
  } catch {
    return null;
  }
}
