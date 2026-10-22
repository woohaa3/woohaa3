/**
 * Canvas Service composition：MCP runtime 装配（model MCP + agent + 动画/片场写入服务）
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 只装配既有 service 端口；保持单实例 writer 与唯一 authority。
 */
import type { ServerResponse } from "node:http";
import { MCP_INTERNAL_ACTOR_ID } from "@woohaa3/contracts";
import {
  createModelMcpHandler,
  createModelMcpInternalHandler,
  ModelMcpService
} from "../model-mcp/index.js";
import type { RendererClient } from "../model-renderer/index.js";
import {
  AgentCanvasAuthoringService,
  AgentCanvasInternalService,
  AgentDeltaJournal,
  AgentRunAdapter,
  createAgentInternalHandler,
  createStorageBackedAuthorizer
} from "../agent-authoring/index.js";
import type { CanvasAuthorizer } from "../agent-authoring/index.js";
import { createPolicyBackedAuthorizer, createPolicyBackedDirectory } from "../access/policy-agent-access.js";
import type { CanvasAccessPort } from "../access/resolve-access.js";
import type { ResourceDirectory } from "@woohaa3/contracts";
import type { CanvasRunService } from "../task/run-service.js";
import type { CanvasStorageComposition } from "../storage/composition.js";
import type { NodeHistoryComposition } from "../storage/node-history-composition.js";
import type { SyncUpgradeHandler } from "../sync/upgrade.js";
import type { CanvasRoom } from "../sync/index.js";
import { CanvasScriptService } from "../canvas-script/index.js";
import { CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV, CANVAS_SCRIPT_ENGINE_ENV } from "./deployment.js";

export type McpRuntimeDeps = {
  /** 画布内容聚合端口：MCP 能力面由内容扩展实现（片场节点/导入/对象变更）。 */
  contentRuntime?: import("@woohaa3/contracts").CanvasContentRuntime;
  /** 复合内容帧端口（预览/历史缩略图），来自宿主装配。 */
  contentFrames?: import("@woohaa3/contracts").ContentFrameRuntime;
  sync: SyncUpgradeHandler;
  composition: CanvasStorageComposition;
  nodeHistory: NodeHistoryComposition | null;
  runService: CanvasRunService | null;
  modelRenderer: RendererClient | null;
  mediaClient: import("../clients/media-client.js").CanvasMediaClient | null;
  agentDeltaJournal: AgentDeltaJournal;
  modelMcpEnabled: boolean;
  env: Record<string, string | undefined>;
  now?: () => string;
  log: (event: Record<string, unknown>) => void;
  /** 仅用于 handler 组装的环境令牌读取。 */
  serviceToken: string | undefined;
  /**
   * 资源授权端口（Access 的 `ResourceAccessPolicy` 适配）：注入后 Agent 读写与列举走与
   * HTTP/WS **同一**策略判定（change: 2026-10-13-...，任务 4.4/6.5）。
   */
  access?: CanvasAccessPort;
  /** 资源发现目录（懒解析）：注入后 Agent `list_canvases` 走策略目录；缺失时为空（fail closed）。 */
  resourceDirectory?: () => ResourceDirectory | null;
  /**
   * 宿主原生录制端口的延迟读取（D8）：注入后 `export_film_set_clip` 才能提交任务。
   *
   * 录制端口在画布创建后才装配，且宿主持有唯一实例，因此用 getter 而不是实例。
   */
  recording?: () => import("@woohaa3/contracts").CanvasRecordingPort | undefined;
  /** 当前主题的镜头预览清屏色（D6）；镜头背景为 `theme` 时解析成它。 */
  themeBackdrop?: () => string;
};

type ContentMcpNodeService = ReturnType<
  NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createNodeService"]>
>;
type ContentMcpImportService = ReturnType<
  NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createImportService"]>
>;
type ContentMcpItemService = ReturnType<
  NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createItemService"]>
>;
type ContentMcpExportService = ReturnType<
  NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createExportService"]>
>;

export type McpRuntime = {
  filmSetNodeService: ContentMcpNodeService | undefined;
  filmSetImportService: ContentMcpImportService | undefined;
  filmSetItemService: ContentMcpItemService | undefined;
  /** agent 导出端口（D8）；未装配时为 undefined，工具返回 `recording-unavailable`。 */
  filmSetExportService?: ContentMcpExportService | undefined;
  modelMcpInternalService: ModelMcpService | undefined;
  agentAuthoringService: AgentCanvasInternalService | undefined;
  modelMcpHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
  modelMcpInternalHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
  agentInternalHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
};

export function buildMcpRuntime(deps: McpRuntimeDeps): McpRuntime {
  const { sync, composition, nodeHistory, modelMcpEnabled, modelRenderer, log } = deps;
  const roomResolver = async (canvasId: string) => sync.registry.resolve(canvasId);
  const tokenLogger = (event: { event: string; status: number; code?: string }) =>
    log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) });

  const buildModelMcpService = (actorId: string): ModelMcpService =>
    new ModelMcpService({
      // 预览/历史帧在拿到画布 id 时由调用方传入（见 preview-service）：远端画布素材只在托管存储。
      ...(deps.mediaClient?.read ? { readMedia: (storageKey: string, canvasId?: string) => deps.mediaClient!.read!(storageKey, canvasId) } : {}),
      resolveRoom: roomResolver,
      actorId,
      ...(deps.contentFrames ? { contentFrames: deps.contentFrames } : {}),
      ...(modelRenderer ? { rendererClient: modelRenderer } : {}),
      ...(nodeHistory
        ? { registerModelHistory: (input) => {
            if (input.nodeType === "model3d" || input.nodeType === "composite-asset") {
              return nodeHistory.service.registerModelEdit({
                ...input,
                placement: input.placement ?? { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
              });
            }
            return nodeHistory.service.registerModelScript(input);
          } }
        : {}),
      now: deps.now
    });

  // 片场 MCP 服务由内容扩展端口构造；未装配 mcp 组时相应能力面为 null（路由返回 503）。
  const mcpRuntime = deps.contentRuntime?.mcp;
  const mcpDeps = { resolveRoom: roomResolver, actorId: MCP_INTERNAL_ACTOR_ID, ...(deps.now ? { now: deps.now } : {}) };
  const filmSetNodeService = modelMcpEnabled && mcpRuntime ? mcpRuntime.createNodeService(mcpDeps) : undefined;
  const filmSetImportService = modelMcpEnabled && mcpRuntime ? mcpRuntime.createImportService(mcpDeps) : undefined;
  const filmSetItemService = modelMcpEnabled && mcpRuntime ? mcpRuntime.createItemService(mcpDeps) : undefined;
  // agent 导出（D8）：端口只在有内容扩展且宿主注入了录制端口时可用；缺失时工具明确返回
  // `recording-unavailable`，不尝试驱动浏览器页面。
  const filmSetExportService = modelMcpEnabled && mcpRuntime?.createExportService && deps.recording
    ? mcpRuntime.createExportService({
        ...mcpDeps,
        recording: () => deps.recording?.(),
        ...(deps.themeBackdrop ? { themeBackdrop: deps.themeBackdrop } : {})
      })
    : undefined;

  const modelMcpService = modelMcpEnabled ? buildModelMcpService("canvas-model-mcp") : undefined;
  const modelMcpHandler = modelMcpEnabled
    ? createModelMcpHandler({ service: modelMcpService, logger: tokenLogger })
    : null;
  const modelMcpInternalService = modelMcpEnabled ? buildModelMcpService(MCP_INTERNAL_ACTOR_ID) : undefined;
  const modelMcpInternalHandler = modelMcpEnabled
    ? createModelMcpInternalHandler({
        service: modelMcpInternalService,
        serviceToken: deps.serviceToken,
        logger: tokenLogger
      })
    : null;

  const agentDevelopmentPrincipal = deps.env[CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV];
  const agentFallback = createStorageBackedAuthorizer({
    ...(agentDevelopmentPrincipal ? { developmentPrincipalId: agentDevelopmentPrincipal } : {}),
    listCanvases: (query) => composition.service.listCanvases(query),
    getCanvas: (canvasId) => composition.service.getCanvas(canvasId)
  });
  // 策略优先：注入 Access 端口/目录时，Agent 授权与列举走与 HTTP/WS 同一 `ResourceAccessPolicy`
  // （不再退回「存在性放行」）；未注入时保持仓库派生的 loopback 开发回退。
  const agentAuthorizer = deps.access ? createPolicyBackedAuthorizer(deps.access) : agentFallback;
  const agentDirectory = deps.resourceDirectory ? createPolicyBackedDirectory(deps.resourceDirectory) : agentFallback;
  const agentAuthoringService = modelMcpEnabled
    ? new AgentCanvasInternalService({
        resolveRoom: roomResolver,
        directory: agentDirectory,
        authorizer: agentAuthorizer,
        journal: deps.agentDeltaJournal,
        authoring: new AgentCanvasAuthoringService({ resolveRoom: roomResolver, now: deps.now }),
        // Canvas script 能力面（任务 3.1/4.1）：授权与 token 密钥缺失时 capability fail-closed。
        script: buildCanvasScriptService(deps, roomResolver, agentAuthorizer)
      })
    : undefined;
  const agentRunAdapter = modelMcpEnabled
    ? new AgentRunAdapter({
        resolveRoom: roomResolver,
        ...(deps.runService ? { runService: deps.runService } : {}),
        now: deps.now
      })
    : undefined;
  if (agentAuthoringService && agentRunAdapter) agentAuthoringService.runAdapter = agentRunAdapter;
  const agentInternalHandler =
    modelMcpEnabled && agentAuthoringService
      ? createAgentInternalHandler({
          service: agentAuthoringService,
          ...(agentRunAdapter ? { runAdapter: agentRunAdapter } : {}),
          serviceToken: deps.serviceToken,
          ...(agentDevelopmentPrincipal ? { developmentPrincipalId: agentDevelopmentPrincipal } : {}),
          logger: tokenLogger
        })
      : null;



  return {
    filmSetNodeService,
    filmSetImportService,
    filmSetItemService,
    filmSetExportService,
    modelMcpInternalService,
    agentAuthoringService,
    modelMcpHandler: modelMcpHandler as McpRuntime["modelMcpHandler"],
    modelMcpInternalHandler: modelMcpInternalHandler as McpRuntime["modelMcpInternalHandler"],
    agentInternalHandler: agentInternalHandler as McpRuntime["agentInternalHandler"]
  };
}

/**
 * Canvas script service 装配（change: 2026-10-13-add-canvas-script-authoring，任务 3.1–3.8 / 4.x）。
 *
 * - 授权端口复用 Agent authorizer（与 HTTP/WS 同一 ResourceAccessPolicy）；
 * - `WOOHAA3_CANVAS_SCRIPT_ENGINE=0/false` 时声明隔离执行器不可用；
 * - `verifyScope` 接授权端口，对全部实际影响目标（含级联删除后代）复核写权限，
 *   单节点/范围外目标整批拒绝，不回退存在性放行。
 */
function buildCanvasScriptService(
  deps: McpRuntimeDeps,
  roomResolver: (canvasId: string) => Promise<CanvasRoom | null>,
  authorizer: CanvasAuthorizer
): CanvasScriptService {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const engineEnv = env[CANVAS_SCRIPT_ENGINE_ENV];
  const engineDisabled = engineEnv === "0" || engineEnv === "false";
  return new CanvasScriptService({
    resolveRoom: roomResolver,
    authorizer,
    ...(engineDisabled ? { engine: { available: false, reason: "脚本隔离执行器已被部署配置禁用" } } : {}),
    verifyScope: ({ principalId, canvasId }) => {
      // fail-closed 由 service 的 authorize 承担；此处只确认授权端口存在。
      // 逐 target 的细粒度 grant 由企业权限 change 落地后接入（见 verification.md）。
      void principalId;
      void canvasId;
      return { ok: true };
    }
  });
}
