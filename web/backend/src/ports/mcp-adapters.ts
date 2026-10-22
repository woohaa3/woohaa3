import { currentCanvasGroupScope } from "@woohaa3/canvas-service";
/**
 * MCP → Canvas 进程内适配器
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 2.1 / design D2）。
 *
 * 统一后端进程内，MCP 模块不再通过 HTTP 调用 Canvas 内部协议，而是直接调用 Canvas 暴露的
 * `ModelMcpService` / `AgentCanvasInternalService`。授权、actorId、错误映射仍由 Canvas 侧完成；
 * 本适配器只做形状转换。
 */
import type { AgentCanvasInternalService, ModelMcpService, CreateFilmSetNodeOutcome } from "@woohaa3/canvas-service";
import type {
  CanvasCommand,
  McpCameraMutation,
  McpCreateFilmSetNodeRequest,
  McpImportModelSnapshotRequest,
  McpMutateFilmSetItemRequest,
  SupportedModelScriptVersion
} from "@woohaa3/contracts";
import type { CanvasMcpClient } from "@woohaa3/mcp-service";
import type { AgentCanvasClient, McpMutateFilmSetItemResult } from "@woohaa3/mcp-service";

type MutateFilmSetItemOutcome = McpMutateFilmSetItemResult;

const MCP_ACTOR_CANVAS_READ = "canvas-model-mcp";
const MCP_ACTOR_CANVAS_INTERNAL = "wolf-woohaa3-mcp-internal-actor";

/** ModelMcpService（内部 actor）→ MCP CanvasMcpClient。 */
export function modelMcpServiceToClient(
  service: ModelMcpService | null,
  options: {
    /** 动画节点权威写入（change: 2026-10-05-bind-model-animation-to-shots）。 */
    createFilmSetNode?: (input: McpCreateFilmSetNodeRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>;
    commitAnimation?: (input: import("@woohaa3/contracts").McpCommitAnimationRequest) => Promise<CreateFilmSetNodeOutcome>;
    importModelSnapshot?: (input: McpImportModelSnapshotRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>;
    /** 片场对象级权威变更（change: 2026-10-09-add-film-set-object-motion-and-editing）。 */
    mutateFilmSetItem?: (input: McpMutateFilmSetItemRequest & { canvasId: string }) => Promise<MutateFilmSetItemOutcome>;
  }
): CanvasMcpClient {
  const unavailable = { ok: false as const, code: "unavailable", message: "模型 MCP 当前不可用" };
  // change: 2026-10-07-remove-residual-compatibility —— 不再提供默认画布回退；canvasId 必填。
  const canvasId = (value: string | undefined) => value ?? "";
  void MCP_ACTOR_CANVAS_READ;
  void MCP_ACTOR_CANVAS_INTERNAL;
  return {
    async listModelNodes(input) {
      if (!service) return unavailable as never;
      return service.listModelNodes({ canvasId: input.canvasId }) as never;
    },
    async getModelNode(input) {
      if (!service) return unavailable as never;
      return service.getModelNode({
        canvasId: canvasId(input.canvasId),
        nodeId: input.nodeId,
        ...(input.includeStatistics === true ? { includeStatistics: true } : {})
      }) as never;
    },
    async getModelStatistics(input) {
      if (!service?.getModelStatistics) return unavailable as never;
      return service.getModelStatistics({
        canvasId: canvasId(input.canvasId),
        nodeId: input.nodeId,
        ...(input.source === undefined ? {} : { source: input.source })
      }) as never;
    },
    async submitScript(input) {
      if (!service) return unavailable as never;
      return service.submitScript({
        canvasId: canvasId(input.canvasId),
        nodeId: input.nodeId,
        source: input.source,
        requestId: input.requestId ?? "",
        ...(input.version ? { version: input.version as SupportedModelScriptVersion } : {}),
        ...(input.expectedModelContentHash === undefined
          ? {}
          : { expectedModelContentHash: input.expectedModelContentHash })
      }) as never;
    },
    async renderPreview(input) {
      if (!service?.renderPreview) return { ok: false, code: "renderer-unavailable", message: "模型预览当前不可用" } as never;
      return service.renderPreview({
        canvasId: canvasId(input.canvasId),
        nodeId: input.nodeId,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.background !== undefined ? { background: input.background } : {}),
        ...(input.cameraPreset !== undefined ? { cameraPreset: input.cameraPreset } : {}),
        ...(input.timeSeconds !== undefined ? { timeSeconds: input.timeSeconds } : {}),
        ...(input.clipId !== undefined ? { clipId: input.clipId } : {})
      }) as never;
    },
    async applyCommands(input) {
      if (!service?.applyCommands) return unavailable as never;
      return service.applyCommands({
        canvasId: canvasId(input.canvasId),
        commandId: input.commandId,
        baseRevision: input.baseRevision,
        commands: input.commands
      }) as never;
    },
    async mutateCameras(input) {
      if (!service?.mutateCameras) return unavailable as never;
      return service.mutateCameras({
        canvasId: canvasId(input.canvasId),
        nodeId: input.nodeId,
        requestId: input.requestId,
        mutation: input.mutation
      }) as never;
    },
    // 模型批量作者（model-script-batch）：进程内直接复用 Canvas 权威服务，不经 HTTP；
    // principalId 使用内部 actor，与 HTTP 内部面派生出的 actor 语义一致。
    async getModelNodes(input) {
      if (!service?.getModelNodes) return unavailable as never;
      return service.getModelNodes(input) as never;
    },
    async validateScripts(input) {
      if (!service?.validateScripts) return unavailable as never;
      return service.validateScripts(input, { principalId: MCP_ACTOR_CANVAS_INTERNAL }) as never;
    },
    async submitScripts(input) {
      if (!service?.submitScripts) return unavailable as never;
      return service.submitScripts(input, { principalId: MCP_ACTOR_CANVAS_INTERNAL }) as never;
    },
    async createFilmSetNode(input) {
      if (!options.createFilmSetNode) return unavailable as never;
      return options.createFilmSetNode({ ...input, canvasId: canvasId(input.canvasId) }) as never;
    },
    async importModelSnapshot(input) {
      if (!options.importModelSnapshot) return unavailable as never;
      return options.importModelSnapshot({ ...input, canvasId: canvasId(input.canvasId) }) as never;
    },
    async commitAnimation(input) {
      if (!options.commitAnimation) return unavailable as never;
      return options.commitAnimation({ ...input, canvasId: canvasId(input.canvasId) }) as never;
    },
    async mutateFilmSetItem(input) {
      if (!options.mutateFilmSetItem) return unavailable as never;
      return options.mutateFilmSetItem({ ...input, canvasId: canvasId(input.canvasId) }) as never;
    },
    async ready() {
      return service ? { ready: true } : { ready: false, reason: "模型 MCP 当前不可用" };
    }
  };
}

/** AgentCanvasInternalService → MCP AgentCanvasClient（带固定内部 principal）。 */
export function agentCanvasServiceToClient(
  service: AgentCanvasInternalService | null,
  options: { principalId: string }
): AgentCanvasClient {
  const unavailable = { ok: false as const, code: "unavailable", message: "Agent Canvas 当前不可用" };
  return {
    async listCanvases(input) {
      if (!service) return unavailable as never;
      if (!options.principalId.trim()) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
      const page = await service.listCanvases({ principalId: currentCanvasGroupScope()?.owner ?? options.principalId, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) });
      return { ok: true, ...page };
    },
    async getGraph(input) {
      if (!service) return unavailable as never;
      return service.readGraph({
        principalId: currentCanvasGroupScope()?.owner ?? options.principalId,
        ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {}),
        ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
        ...(input.aroundNodeId !== undefined ? { aroundNodeId: input.aroundNodeId } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
        ...(input.includePrompt !== undefined ? { includePrompt: input.includePrompt } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
      } as never) as never;
    },
    async getChanges(input) {
      if (!service) return unavailable as never;
      return service.readChanges({
        principalId: currentCanvasGroupScope()?.owner ?? options.principalId,
        ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {}),
        sinceRevision: input.sinceRevision,
        ...(input.limit !== undefined ? { limit: input.limit } : {})
      }) as never;
    },
    async scriptCapability(input) { return service ? service.scriptCapability({ ...input, principalId: currentCanvasGroupScope()?.owner ?? options.principalId }) as never : unavailable as never; },
    async validateScript(input) { return service ? service.validateScript({ ...input, principalId: currentCanvasGroupScope()?.owner ?? options.principalId }) as never : unavailable as never; },
    async submitScript(input) { return service ? service.submitScript({ ...input, principalId: currentCanvasGroupScope()?.owner ?? options.principalId }) as never : unavailable as never; },
    async runNode(input) { return service?.runAdapter ? service.runAdapter.run({ ...input, canvasId: input.canvasId ?? "" }) as never : unavailable as never; },
    async getRun(input) { return service?.runAdapter ? service.runAdapter.status({ ...input, canvasId: input.canvasId ?? "" }) as never : unavailable as never; },
    async cancelRun(input) { return service?.runAdapter ? service.runAdapter.cancel({ ...input, canvasId: input.canvasId ?? "" }) as never : unavailable as never; },
    async getOutput(input) { return service?.runAdapter ? service.runAdapter.output({ ...input, canvasId: input.canvasId ?? "" }) as never : unavailable as never; },
    async applyPlan(input) {
      if (!service) return unavailable as never;
      return service.apply({ ...(input as object), principalId: currentCanvasGroupScope()?.owner ?? options.principalId } as never) as never;
    }
  };
}

export type { CanvasCommand, McpCameraMutation };
