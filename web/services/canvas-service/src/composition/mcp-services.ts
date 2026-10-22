/**
 * Canvas Service composition：MCP 能力面投影
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 只装配既有 service 端口为进程内能力面；不新增跨域实现依赖，不改变拓扑。
 */
import type {
  FilmSetNodeOutcome,
  ImportFilmSetContentOutcome,
  McpCreateFilmSetNodeRequest,
  McpImportFilmSetContentRequest,
  McpImportModelSnapshotRequest,
  McpMutateFilmSetItemRequest,
  MutateFilmSetItemOutcome,
  ReadFilmSetOutcome
} from "@woohaa3/contracts";
import type { ModelMcpService } from "../model-mcp/index.js";
import type { AgentCanvasInternalService } from "../agent-authoring/index.js";

/** `CanvasService.mcpServices` 的返回形状（与 composition types 对齐）。 */
export type McpServicesProjection = {
  modelMcp: ModelMcpService | null;
  agent: AgentCanvasInternalService | null;
  createFilmSetNode: ((input: McpCreateFilmSetNodeRequest & { canvasId: string }) => Promise<FilmSetNodeOutcome>) | null;
  importModelSnapshot: ((input: McpImportModelSnapshotRequest & { canvasId: string }) => Promise<FilmSetNodeOutcome>) | null;
  importFilmSetContent: ((input: McpImportFilmSetContentRequest & { canvasId: string }) => Promise<ImportFilmSetContentOutcome>) | null;
  commitAnimation: ((input: import("@woohaa3/contracts").McpCommitAnimationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>) | null;
  confirmAdaptation: ((input: import("@woohaa3/contracts").McpConfirmAdaptationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>) | null;
  readAnimation: ((input: { canvasId: string; nodeId: string }) => Promise<ReadFilmSetOutcome>) | null;
  mutateFilmSetItem: ((input: McpMutateFilmSetItemRequest & { canvasId: string }) => Promise<MutateFilmSetItemOutcome>) | null;
  /** 片场媒体条目受控导入（D5）；未装配时为 null，工具明确不可用。 */
  addFilmSetMedia?: ((input: import("@woohaa3/contracts").McpAddFilmSetMediaRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpAddFilmSetMediaOutcome>) | null;
  /** agent 发起显式导出（D8）；未装配时为 null/缺失，工具返回 `recording-unavailable`。 */
  exportFilmSetClip?: ((input: import("@woohaa3/contracts").McpExportFilmSetClipRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpExportFilmSetClipOutcome>) | null;
  getFilmSetExport?: ((input: import("@woohaa3/contracts").McpGetFilmSetExportRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpGetFilmSetExportOutcome>) | null;
};

/**
 * 由既有 service 构造 `mcpServices` 投影。
 *
 * `internalModelMcp` 为内部协议面 actor 的 ModelMcpService；`agent` 为 Agent 内部服务。
 */
export type NodeServicePort = ReturnType<NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createNodeService"]>>;
type ImportServicePort = ReturnType<NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createImportService"]>>;
type ItemServicePort = ReturnType<NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createItemService"]>>;
type ExportServicePort = ReturnType<NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createExportService"]>>;

export function buildMcpServicesProjection(input: {
  filmSetNodeService: NodeServicePort | undefined;
  filmSetImportService: ImportServicePort | undefined;
  filmSetItemService: ItemServicePort | undefined;
  /** 导出端口（D8）；缺失时工具返回 `recording-unavailable`。 */
  filmSetExportService?: ExportServicePort | undefined;
  internalModelMcp: ModelMcpService | null;
  agent: AgentCanvasInternalService | null;
}): McpServicesProjection {
  const { filmSetNodeService, filmSetImportService, filmSetItemService, filmSetExportService } = input;
  // 片场 DTO → 领域输入的适配已归扩展（ContentMcpRuntime），这里只做能力面投影。
  return {
    modelMcp: input.internalModelMcp,
    agent: input.agent,
    createFilmSetNode: filmSetNodeService ? (request) => filmSetNodeService.createNode(request) : null,
    importModelSnapshot: filmSetNodeService ? (request) => filmSetNodeService.importModelSnapshot(request) : null,
    importFilmSetContent: filmSetImportService ? (request) => filmSetImportService.importContent(request) : null,
    commitAnimation: filmSetNodeService ? (request) => filmSetNodeService.commitAnimation(request) : null,
    confirmAdaptation: filmSetNodeService ? (request) => filmSetNodeService.confirmAdaptation(request) : null,
    readAnimation: filmSetNodeService ? (request) => filmSetNodeService.readAnimation(request) : null,
    mutateFilmSetItem: filmSetItemService ? (request) => filmSetItemService.mutateItem(request) : null,
    addFilmSetMedia: filmSetImportService?.addMedia ? (request) => filmSetImportService.addMedia!(request) : null,
    exportFilmSetClip: filmSetExportService ? (request) => filmSetExportService.startExport(request) : null,
    getFilmSetExport: filmSetExportService ? (request) => filmSetExportService.getExport(request) : null
  };
}
