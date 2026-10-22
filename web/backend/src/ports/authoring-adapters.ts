/**
 * Application 插件端口 → Canvas/Media 权威的**进程内**适配器
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 3.4/3.5 / design D7/D8）。
 *
 * 统一后端进程内，插件经公共 `ApplicationAuthoringServices` 端口读写；实现把端口调用映射到
 * Canvas 的 `mcpServices()`（ModelMcpService + FilmSetNodeService）与 Media 的受限签名。
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
  ApplicationToolGrant
} from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import { randomUUID } from "node:crypto";
import { CANVAS_GROUP_TOOLS } from "@woohaa3/contracts";
import { canvasGroupEpoch } from "@woohaa3/canvas-service";
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

/** 稳定工具 grant 的内存注册表（签发/校验/回收）；工具入口据此限制范围与预算。 */
export type ToolGrantRegistry = {
  issue: (grant: ApplicationToolGrant, subject?: string) => void;
  subject: (token: string) => string | undefined;
  verify: (token: string) => ApplicationToolGrant | null;
  revoke: (workId: string, subject?: string) => void;
  /** 记录一次调用；超出预算返回 false。 */
  consume: (token: string) => boolean;
  /**
   * 工具入口强制校验（change: 2026-10-08-unlock-...，任务 3.6 / design D8）。
   *
   * 校验 token 有效性、工具允许集合、目标画布/节点范围与调用预算；任一不满足返回
   * `{ ok:false, reason }`，并**不**消耗预算（失败不记账）。成功时消耗一次调用预算。
   */
  authorize: (input: { token: string; tool: string; canvasId?: string; nodeId?: string; cameraId?: string; clipId?: string; itemId?: string }) => { ok: true } | { ok: false; reason: string };
};

export function createToolGrantRegistry(now: () => number = () => Date.now()): ToolGrantRegistry {
  const grants = new Map<string, ApplicationToolGrant & { calls: number; workId: string; subject?: string }>();
  return {
    subject: token => grants.get(token)?.subject,
    issue(grant, subject) {
      grants.set(grant.token, { ...grant, calls: 0, subject, workId: (grant as ApplicationToolGrant & { workId?: string }).workId ?? "" });
    },
    verify(token) {
      const grant = grants.get(token);
      if (!grant) return null;
      if (grant.expiresAt <= now()) {
        grants.delete(token);
        return null;
      }
      return grant;
    },
    revoke(workId, subject) {
      for (const [token, grant] of grants) {
        if ((grant as { workId?: string }).workId === workId && (subject === undefined ? !grant.groupScope : subject === grant.subject)) grants.delete(token);
      }
    },
    consume(token) {
      const grant = grants.get(token);
      if (!grant) return false;
      if (grant.expiresAt <= now() || grant.calls >= grant.maxCalls) return false;
      grant.calls += 1;
      return true;
    },
    authorize(input) {
      const grant = grants.get(input.token);
      if (!grant) return { ok: false, reason: "unknown-grant" };
      if (grant.expiresAt <= now()) {
        grants.delete(input.token);
        return { ok: false, reason: "expired" };
      }
      if (grant.calls >= grant.maxCalls) return { ok: false, reason: "budget-exhausted" };
      if ((grant.groupScope || grant.tools.length > 0) && !grant.tools.includes(input.tool)) return { ok: false, reason: "tool-not-allowed" };
      if (grant.groupScope && canvasGroupEpoch(grant.groupScope.canvasId, grant.groupScope.rootGroupId) !== grant.groupScope.scopeEpoch) return { ok: false, reason: "group-scope-revoked" };
      if (input.canvasId !== undefined && grant.canvasIds.length > 0 && !grant.canvasIds.includes(input.canvasId)) {
        return { ok: false, reason: "canvas-not-allowed" };
      }
      if (!grant.groupScope && input.nodeId !== undefined && grant.nodeIds.length > 0 && !grant.nodeIds.includes(input.nodeId)) {
        return { ok: false, reason: "node-not-allowed" };
      }
      if (grant.cameraId && !input.tool.startsWith("get_") && input.cameraId !== grant.cameraId) return { ok: false, reason: "camera-not-allowed" };
      if (input.tool === "submit_film_set" && (grant.itemId || grant.clipId || grant.cameraId)) return { ok: false, reason: "whole-film-set-not-allowed" };
      if (grant.itemId && input.tool === "mutate_film_set_clip" && input.itemId !== grant.itemId) return { ok: false, reason: "item-not-allowed" };
      if (grant.clipId && input.tool === "mutate_film_set_clip" && input.clipId !== grant.clipId) return { ok: false, reason: "clip-not-allowed" };
      grant.calls += 1;
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
      const rootRoom = await deps.canvas.sync?.registry.resolve(input.canvasId);
      const rootSnapshot = rootRoom?.exportCanvas();
      const root = rootSnapshot?.ok ? rootSnapshot.canvas.document.nodes.find(n => n.id === input.nodeId) : undefined;
      if (root?.type === "group") {
        const access = await deps.canvas.mcpServices().agent?.authorizeCanvas({ principalId: input.delegation.subject, canvasId: input.canvasId, permission: "read" });
        if (!access?.ok) return { ok: false, code: "unauthorized", message: "无权读取目标画布" };
        return { ok: true, nodeType: "group", title: String(rootSnapshot!.ok && rootSnapshot!.canvas.nodeData[input.nodeId]?.title || "创作组"), prompt: "", references: [], cameras: [], snapshotHash: `group-epoch:${canvasGroupEpoch(input.canvasId, input.nodeId)}` };
      }
      const services = deps.canvas.mcpServices();
      const modelMcp = services.modelMcp;
      if (!modelMcp) return { ok: false, code: "unavailable", message: "模型 MCP 当前不可用" };
      const node = await modelMcp.getModelNode({ canvasId: input.canvasId, nodeId: input.nodeId });
      if (!node.ok) return { ok: false, code: node.code, message: node.message };
      let animation: unknown;
      if (services.readAnimation) {
        const read = await services.readAnimation({ canvasId: input.canvasId, nodeId: input.nodeId });
        if (read.ok) animation = read.animation;
      }
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
        ...(animation ? { animation } : {}),
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
    async commitAnimation(input): Promise<ApplicationAuthoringWriteOutcome> {
      delegateOrThrow(input.delegation, log);
      const services = deps.canvas.mcpServices();
      if (!services.commitAnimation) return { ok: false, code: "unavailable", message: "动画提交端口当前不可用" };
      const outcome = await services.commitAnimation({
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        requestId: input.operationId,
        animation: input.animation,
        ...(input.clipId ? { clipId: input.clipId } : {}),
        ...(input.expectedClipHash ? { expectedClipHash: input.expectedClipHash } : {}),
        ...(input.expectedSnapshotHash ? { expectedSnapshotHash: input.expectedSnapshotHash } : {})
      });
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
      return { ok: true, canvasId: outcome.canvasId, nodeId: outcome.nodeId, commandId: outcome.commandId, duplicate: outcome.duplicate, noop: outcome.noop };
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
      if (request.mode !== undefined && !["model3d", "film-set", "camera", "canvas-group"].includes(request.mode)) throw new Error("unsupported-target-mode");
      if (request.mode === "canvas-group") {
        if (!request.tools?.length) throw new Error("group-tools-required");
        if (request.tools.some(tool => !(CANVAS_GROUP_TOOLS as readonly string[]).includes(tool))) throw new Error("group-tool-not-supported");
        const access = await deps.canvas.mcpServices().agent?.authorizeCanvas({ principalId: request.delegation.subject, canvasId: request.canvasId, permission: "write" });
        if (!access?.ok) throw new Error("write-forbidden");
        const room = await deps.canvas.sync?.registry.resolve(request.canvasId);
        const exported = room?.exportCanvas();
        if (!exported?.ok || !exported.canvas.document.nodes.some(n => n.id === request.nodeId && n.type === "group")) throw new Error("group-target-missing");
        if (request.expectedScopeEpoch === undefined || request.expectedScopeEpoch !== canvasGroupEpoch(request.canvasId, request.nodeId)) throw new Error("group-scope-revoked");
      }
      const grant: ApplicationToolGrant = {
        ...(request.mode === "canvas-group" ? { groupScope: { canvasId: request.canvasId, rootGroupId: request.nodeId, scopeEpoch: canvasGroupEpoch(request.canvasId, request.nodeId) } } : {}),
        token: `grant-${randomUUID()}`,
        canvasIds: [request.canvasId],
        nodeIds: [request.nodeId],
        ...(request.cameraId ? { cameraId: request.cameraId } : {}),
        ...(request.clipId ? { clipId: request.clipId } : {}),
        ...(request.itemId ? { itemId: request.itemId } : {}),
        tools: request.tools ?? [],
        maxCalls: request.maxCalls ?? 40,
        expiresAt: Date.now() + (request.ttlMs ?? 30 * 60 * 1000)
      };
      (grant as ApplicationToolGrant & { workId?: string }).workId = request.workId;
      grants.issue(grant, request.delegation.subject);
      return grant;
    },
    revoke: (workId, delegation) => grants.revoke(workId, delegation?.subject),
    /**
     * 工具入口强制校验（任务 3.6 / design D8）：宿主在 MCP 工具调用点用它与 bearer 令牌核对。
     * 成功消耗预算，失败不记账。
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
