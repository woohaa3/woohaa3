/**
 * 片场 MCP 能力面：结果 DTO 与宿主 ↔ 扩展端口
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 画布宿主的 MCP 能力面（`createFilmSetNode` / `commitAnimation` / `importFilmSetContent` /
 * `mutateFilmSetItem` 等）只认识这些**纯数据 DTO** 与端口方法；片场领域服务
 * （`FilmSetNodeService` 等）由扩展实现，经 `ContentMcpRuntime` 工厂注入。
 *
 * 请求侧 DTO（`Mcp*Request`）已在 `canvas/mcp-internal` 里定义，是宿主与前端共享的协议；
 * 这里补上结果侧，避免宿主 import 扩展实现只为拿返回类型。
 */
import type { CanvasAuthority } from "../backend/canvas-authority.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import type {
  McpAddFilmSetMediaOutcome,
  McpAddFilmSetMediaRequest,
  McpCommitAnimationRequest,
  McpConfirmAdaptationRequest,
  McpCreateFilmSetNodeRequest,
  McpExportFilmSetClipOutcome,
  McpExportFilmSetClipRequest,
  McpGetFilmSetExportOutcome,
  McpGetFilmSetExportRequest,
  McpImportFilmSetContentRequest,
  McpImportModelSnapshotRequest,
  McpMutateFilmSetItemRequest
} from "./mcp-internal.js";

/** 片场节点写入结果（创建/导入/提交/确认共用）。 */
export type FilmSetNodeOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      /** 提交后的完整动画节点数据（从权威回流读取）。 */
      animation: FilmSetNodeData;
    }
  | { ok: false; code: string; message: string };

/** 读取完整动画定义结果（生成层构造完整提交前读取权威当前定义）。 */
export type ReadFilmSetOutcome = { ok: true; animation: FilmSetNodeData } | { ok: false; code: string; message: string };

/** 导入片场内容的写入结果。 */
export type ImportFilmSetContentOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      /** 提交后的完整片场内容（从权威回流读取）。 */
      contentHash: string;
      itemCount: number;
    }
  | { ok: false; code: string; message: string };

/** 片场对象级变更结果。 */
export type MutateFilmSetItemOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      itemId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      contentHash: string;
      itemCount: number;
    }
  | { ok: false; code: string; message: string };

/** 构造片场领域服务需要宿主提供的协作者（权威房间、审计 actor、时钟）。 */
export type ContentMcpServiceDeps = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  actorId?: string;
  now?: () => string;
  /**
   * 宿主原生录制端口（D8）。缺失表示纯浏览器宿主：MCP 导出工具返回 `recording-unavailable`。
   *
   * 是 getter 而不是实例：录制端口在画布创建后才装配，且宿主持有唯一实例。
   */
  recording?: () => import("./content-recording-port.js").CanvasRecordingPort | undefined;
  /** 当前主题的镜头预览清屏色；`backdrop: "theme"` 时由扩展解析成它。 */
  themeBackdrop?: () => string;
};

/** 片场 MCP 能力端口：由内容扩展实现，宿主在装配 MCP 能力面时注入。
 *
 * 方法入参统一用**协议 DTO**（`Mcp*Request`），扩展负责 DTO → 领域输入的适配；
 * 宿主不再持有片场领域服务的构造细节。
 */
export type ContentMcpRuntime = {
  createNodeService(deps: ContentMcpServiceDeps): {
    createNode(input: McpCreateFilmSetNodeRequest): Promise<FilmSetNodeOutcome>;
    importModelSnapshot(input: McpImportModelSnapshotRequest): Promise<FilmSetNodeOutcome>;
    commitAnimation(input: McpCommitAnimationRequest): Promise<FilmSetNodeOutcome>;
    confirmAdaptation(input: McpConfirmAdaptationRequest): Promise<FilmSetNodeOutcome>;
    readAnimation(input: { canvasId: string; nodeId: string }): Promise<ReadFilmSetOutcome>;
  };
  createImportService(deps: ContentMcpServiceDeps): {
    importContent(input: McpImportFilmSetContentRequest): Promise<ImportFilmSetContentOutcome>;
    /** 片场媒体条目受控导入（D5）；省略时对应工具明确不可用。 */
    addMedia?(input: McpAddFilmSetMediaRequest): Promise<McpAddFilmSetMediaOutcome>;
  };
  createItemService(deps: ContentMcpServiceDeps): {
    mutateItem(input: McpMutateFilmSetItemRequest): Promise<MutateFilmSetItemOutcome>;
  };
  /**
   * agent 发起显式导出（D8）：只走本机宿主原生录制任务。
   *
   * 省略表示该宿主不提供此能力（纯浏览器），工具返回 `recording-unavailable`。
   */
  createExportService?(deps: ContentMcpServiceDeps): {
    startExport(input: McpExportFilmSetClipRequest): Promise<McpExportFilmSetClipOutcome>;
    getExport(input: McpGetFilmSetExportRequest): Promise<McpGetFilmSetExportOutcome>;
  };
};
