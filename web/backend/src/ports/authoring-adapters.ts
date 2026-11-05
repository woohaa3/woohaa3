/**
 * Application 插件端口 → Canvas/Media 权威的**进程内**适配器
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 3.4/3.5 / design D7/D8）。
 *
 * 统一后端进程内，插件经公共 `ApplicationAuthoringServices` 端口读写；实现把端口调用映射到
 * Canvas 的 `mcpServices()`（ModelMcpService + AgentCanvasInternalService）与 Media 的受限签名。
 * 插件拿不到 Y.Doc、数据库或任意命令入口；内容 precondition/幂等/历史仍由 Canvas 负责。
 *
 * 每一步都绑定可信用户委托（`delegation.subject`）与稳定 operationId；这里做委托存在性校验，
 * 真正的权限/内容校验仍在 Canvas 提交点。
 */
import type {
  ApplicationAuthoringNodeRead,
  ApplicationAuthoringServices,
  ApplicationAuthoringWriteOutcome,
  ApplicationCanvasAuthoringFacade,
  ApplicationMediaReferenceFacade,
  ApplicationPersonalGenerationFacade,
  ApplicationToolDelegationFacade,
  ApplicationUserDelegation,
  ApplicationToolGrant,
  AssistantWorldScopeSelection
} from "@woohaa3/contracts";
import { assistantWorldToolsForScope, CANVAS_GROUP_TOOLS } from "@woohaa3/contracts";
import { canvasGroupEpoch } from "@woohaa3/canvas-service";
import type { CanvasService } from "@woohaa3/canvas-service";
import { randomUUID } from "node:crypto";
import type { MediaService } from "@woohaa3/media-service";

export type AuthoringAdapterDeps = {
  canvas: CanvasService;
  /** Media 受限签名（生成稳定媒体引用）；缺失时参考解析拒绝。 */
  mediaSign?: (storageKey: string, expiresSeconds: number) => Promise<{ ok: true; url: string } | { ok: false; message: string }>;
  /** 个人生成模型目录（按 owner token 查询）；由部署/插件注入。 */
  personalModels?: (delegation: ApplicationUserDelegation) => Promise<{ models: Array<{ id: string; label: string }>; error?: string }>;
  personalExecutable?: (delegation: ApplicationUserDelegation) => Promise<boolean>;
  /** 共享工具 grant registry（任务 3.6）：与 MCP 工具入口同一实例，使签名与校验闭环。 */
  toolGrantRegistry?: ToolGrantRegistry;
  logger?: (event: Record<string, unknown>) => void;
};

/** 稳定工具 grant 的内存注册表（签发/校验/回收）；工具入口据此限制范围与撤销状态。 */
export type ToolGrantRegistry = {
  issue: (grant: ApplicationToolGrant, subject?: string) => void;
  subject: (token: string) => string | undefined;
  verify: (token: string) => ApplicationToolGrant | null;
  /** Host-only snapshot used to invalidate world contexts before dropping grants. */
  list: () => readonly ApplicationToolGrant[];
  revoke: (workId: string, subject?: string) => void;
  /**
   * 工具入口强制校验（change: 2026-10-22-remove-agent-execution-limits，任务 2.1 / design D2）。
   *
   * 校验 token 有效性、工具允许集合、目标画布/节点范围与撤销状态；任一不满足返回
   * `{ ok:false, reason }`。委托没有可耗尽的调用额度，也不按固定时钟到期：合法性只由活动执行
   * 生命周期、权限与范围代次决定。
   */
  authorize: (input: { token: string; tool: string; canvasId?: string; nodeId?: string; cameraId?: string; clipId?: string; itemId?: string }) => { ok: true } | { ok: false; reason: string };
};

/** MCP `tools/list` 的本轮目录：有 grant 就只暴露其 tools，无 token 才给全量发现。 */
export function catalogToolsForGrant(grant: { tools: readonly string[] } | null | undefined): readonly string[] | undefined {
  return grant ? grant.tools : undefined;
}

export function createToolGrantRegistry(): ToolGrantRegistry {
  const grants = new Map<string, ApplicationToolGrant>();
  return {
    subject: token => grants.get(token)?.subject,
    issue(grant, subject) {
      grants.set(grant.token, { ...grant, ...(subject ? { subject } : {}) });
    },
    verify(token) {
      return grants.get(token) ?? null;
    },
    list() {
      return [...grants.values()];
    },
    revoke(workId, subject) {
      for (const [token, grant] of grants) {
        if (grant.workId === workId && (subject === undefined || subject === grant.subject)) grants.delete(token);
      }
    },
    authorize(input) {
      const grant = grants.get(input.token);
      if (!grant) return { ok: false, reason: "unknown-grant" };
      if (grant.tools.length > 0 && !grant.tools.includes(input.tool)) return { ok: false, reason: "tool-not-allowed" };
      if (grant.groupScope && canvasGroupEpoch(grant.groupScope.canvasId, grant.groupScope.rootGroupId) !== grant.groupScope.scopeEpoch) {
        return { ok: false, reason: "group-scope-revoked" };
      }
      if (input.canvasId !== undefined && grant.canvasIds.length > 0 && !grant.canvasIds.includes(input.canvasId)) {
        return { ok: false, reason: "canvas-not-allowed" };
      }
      if (input.nodeId !== undefined && grant.nodeIds.length > 0 && !grant.nodeIds.includes(input.nodeId)) {
        return { ok: false, reason: "node-not-allowed" };
      }
      if (grant.cameraId && !input.tool.startsWith("get_") && input.cameraId !== grant.cameraId) return { ok: false, reason: "camera-not-allowed" };
      return { ok: true };
    }
  };
}

function delegateOrThrow(delegation: ApplicationUserDelegation | undefined, log: (event: Record<string, unknown>) => void): string {
  if (!delegation || !delegation.subject) {
    log({ event: "authoring-missing-delegation" });
    throw Object.assign(new Error("缺少可信用户委托"), { code: "unauthorized" });
  }
  return delegation.subject;
}

export function createInProcessAuthoringServices(deps: AuthoringAdapterDeps): ApplicationAuthoringServices {
  const log = deps.logger ?? (() => undefined);

  const authoring: ApplicationCanvasAuthoringFacade = {
    async readNode(input): Promise<ApplicationAuthoringNodeRead> {
      delegateOrThrow(input.delegation, log);
      const services = deps.canvas.mcpServices();
      const modelMcp = services.modelMcp;
      if (!modelMcp) return { ok: false, code: "unavailable", message: "模型 MCP 当前不可用" };
      const node = await modelMcp.getModelNode({ canvasId: input.canvasId, nodeId: input.nodeId });
      if (!node.ok) return { ok: false, code: node.code, message: node.message };
      return {
        ok: true,
        nodeType: node.nodeType ?? "model3d",
        title: node.title,
        prompt: node.prompt,
        source: node.source,
        references: node.references.map((reference) => ({
          kind: reference.kind,
          role: reference.role,
          ...(reference.text !== undefined ? { text: reference.text } : {}),
          ...(reference.asset ? { url: reference.asset.url, mediaKind: reference.asset.mediaKind, mediaType: reference.asset.mediaType } : {})
        })),
        ...(node.modelContentVersion ? { modelContentVersion: node.modelContentVersion } : {}),
        ...(node.snapshotHash ? { snapshotHash: node.snapshotHash } : {}),
        cameras: node.cameras
      } as ApplicationAuthoringNodeRead;
    },
    async submitModel(input): Promise<ApplicationAuthoringWriteOutcome> {
      delegateOrThrow(input.delegation, log);
      const modelMcp = deps.canvas.mcpServices().modelMcp;
      if (!modelMcp) return { ok: false, code: "unavailable", message: "模型 MCP 当前不可用" };
      const outcome = await modelMcp.submitScript({
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        source: input.source,
        requestId: input.operationId,
        ...(input.expectedModelContentHash ? { expectedModelContentHash: input.expectedModelContentHash } : {})
      });
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
      return { ok: true, canvasId: outcome.canvasId, nodeId: outcome.nodeId, commandId: outcome.commandId, duplicate: outcome.idempotent, noop: outcome.idempotent };
    },
    async mutateCamerasBatch(input): Promise<ApplicationAuthoringWriteOutcome> {
      delegateOrThrow(input.delegation, log);
      const modelMcp = deps.canvas.mcpServices().modelMcp;
      if (!modelMcp?.mutateCamerasBatch) return { ok: false, code: "unavailable", message: "镜头端口当前不可用" };
      const outcome = await modelMcp.mutateCamerasBatch({
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        requestId: input.operationId,
        mutations: input.mutations
      });
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, ...(outcome.failedIndex !== undefined ? { failedIndex: outcome.failedIndex } : {}) };
      return { ok: true, canvasId: outcome.canvasId, nodeId: outcome.nodeId, commandId: outcome.commandId, duplicate: outcome.duplicate, noop: outcome.noop };
    },
    async receipt(input) {
      delegateOrThrow(input.delegation, log);
      const modelMcp = deps.canvas.mcpServices().modelMcp;
      if (!modelMcp) return { ok: false, code: "unavailable", message: "模型 MCP 当前不可用" };
      // 通过读取节点当前状态判断提交事实（幂等端口在重放时返回同一命令）。
      const node = await modelMcp.getModelNode({ canvasId: input.canvasId, nodeId: input.nodeId });
      if (!node.ok) return { ok: false, code: node.code, message: node.message };
      return { ok: true, committed: true, ...(node.modelContentVersion?.revision !== undefined ? { revision: node.modelContentVersion.revision } : {}) };
    }
  };

  const references: ApplicationMediaReferenceFacade = {
    async resolve(input) {
      delegateOrThrow(input.delegation, log);
      if (!deps.mediaSign) return { ok: false, code: "unavailable", message: "媒体参考解析未配置" };
      const signed = await deps.mediaSign(input.storageKey, 900);
      if (!signed.ok) return { ok: false, code: "unavailable", message: signed.message };
      return { ok: true, url: signed.url, expiresAt: Date.now() + 900_000 };
    }
  };

  const grants = deps.toolGrantRegistry ?? createToolGrantRegistry();
  const tools: ApplicationToolDelegationFacade = {
    async issue(request): Promise<ApplicationToolGrant> {
      delegateOrThrow(request.delegation, log);
      if (request.mode !== undefined && !["model3d", "text", "world", "canvas-group"].includes(request.mode)) throw new Error("unsupported-target-mode");
      if (request.mode === "canvas-group") {
        if (!request.nodeId) throw Object.assign(new Error("2D 组目标缺少根组节点"), { code: "malformed-request" });
        const room = deps.canvas.sync ? await deps.canvas.sync.registry.resolve(request.canvasId) : null;
        const snapshot = room?.exportCanvas();
        const group = snapshot?.ok
          ? snapshot.canvas.document.nodes.find((node) => node.id === request.nodeId && node.type === "workflow-group-2d")
          : undefined;
        if (!snapshot?.ok || !group) throw Object.assign(new Error("2D 组不存在或已删除"), { code: "group-target-missing" });
        const scopeEpoch = canvasGroupEpoch(request.canvasId, request.nodeId);
        if (request.expectedScopeEpoch !== undefined && request.expectedScopeEpoch !== scopeEpoch) {
          throw Object.assign(new Error("2D 组作用域已变化，请重新打开组"), { code: "version-conflict" });
        }
        const grant: ApplicationToolGrant = {
          token: `grant-${randomUUID()}`,
          canvasIds: [request.canvasId],
          // 组作用域按成员表校验，不按单一节点授权。
          nodeIds: [],
          tools: request.tools && request.tools.length > 0 ? request.tools : CANVAS_GROUP_TOOLS,
          workId: request.workId,
          groupScope: { canvasId: request.canvasId, rootGroupId: request.nodeId, scopeEpoch },
          ...(request.credentialEpoch !== undefined ? { credentialEpoch: request.credentialEpoch } : {})
        };
        grants.issue(grant, request.delegation.subject);
        return grant;
      }
      if (request.mode === "world") {
        const scope: AssistantWorldScopeSelection | undefined = request.worldScope;
        if (!scope) throw Object.assign(new Error("世界目标缺少可信范围选择"), { code: "malformed-request" });
        const assistantWorld = deps.canvas.assistantWorld;
        if (!assistantWorld) throw Object.assign(new Error("宿主未装配世界助手权威"), { code: "capability-unsupported" });
        const allowedTools: readonly string[] = [...(scope.kind === "scene-area" ? ["get_model_api"] : []), ...assistantWorldToolsForScope(scope)];
        if (request.tools?.some(tool => !allowedTools.includes(tool))) {
          throw Object.assign(new Error("工具不属于本轮世界范围"), { code: "capability-unsupported" });
        }
        const tools = request.tools?.length ? request.tools : allowedTools;
        const issued = await assistantWorld.issue({
          canvasId: request.canvasId,
          requestId: request.workId,
          runId: request.workId,
          epoch: 0,
          executionId: request.workId,
          scope
        });
        if (!issued.ok) throw Object.assign(new Error(issued.message), { code: issued.code });

        const grant: ApplicationToolGrant = {
          token: `grant-${randomUUID()}`,
          canvasIds: [request.canvasId],
          // World writes are scoped by the issued context, not by card node ids.
          nodeIds: [],
          ...(request.cameraId ? { cameraId: request.cameraId } : {}),
          ...(request.clipId ? { clipId: request.clipId } : {}),
          ...(request.itemId ? { itemId: request.itemId } : {}),
          tools,
          workId: request.workId,
          world: {
            contextId: issued.context.contextId,
            completionId: issued.completionId,
            runId: issued.run.runId,
            epoch: issued.run.epoch,
            executionId: issued.run.executionId,
            scope: issued.context.scope
          },
          ...(request.credentialEpoch !== undefined ? { credentialEpoch: request.credentialEpoch } : {})
        };
        grants.issue(grant, request.delegation.subject);
        return grant;
      }
      const grant: ApplicationToolGrant = {
        token: `grant-${randomUUID()}`,
        canvasIds: [request.canvasId],
        nodeIds: [request.nodeId],
        ...(request.cameraId ? { cameraId: request.cameraId } : {}),
        ...(request.clipId ? { clipId: request.clipId } : {}),
        ...(request.itemId ? { itemId: request.itemId } : {}),
        tools: request.tools ?? [],
        workId: request.workId,
        ...(request.credentialEpoch !== undefined ? { credentialEpoch: request.credentialEpoch } : {})
      };
      grants.issue(grant, request.delegation.subject);
      return grant;
    },
    revoke: (workId, delegation) => {
      // Invalidate the world grant/context before dropping the token. The lease
      // itself stays until the host confirms the exact run stopped.
      for (const grant of grants.list()) {
        if (grant.workId !== workId || (delegation?.subject !== undefined && grant.subject !== delegation.subject)) continue;
        if (grant.world) {
          void deps.canvas.assistantWorld?.cancel({
            canvasId: grant.canvasIds[0] ?? "",
            contextId: grant.world.contextId
          }).catch((error) => log({ event: "assistant-world-cancel-failed", message: error instanceof Error ? error.message : String(error) }));
        }
      }
      grants.revoke(workId, delegation?.subject);
    },
    /**
     * 工具入口强制校验（任务 2.1 / design D2）：宿主在 MCP 工具调用点用它与 bearer 令牌核对。
     * 校验只判范围、权限与撤销状态，不消耗额度。
     */
    authorize: (input) => grants.authorize(input)
  };

  const personalGeneration: ApplicationPersonalGenerationFacade = {
    async models(input) {
      delegateOrThrow(input.delegation, log);
      if (!deps.personalModels) return { models: [], error: "个人生成目录未配置" };
      return deps.personalModels(input.delegation);
    },
    async executable(input) {
      delegateOrThrow(input.delegation, log);
      return deps.personalExecutable ? deps.personalExecutable(input.delegation) : false;
    }
  };

  return { authoring, references, tools, personalGeneration };
}

export type { MediaService };
