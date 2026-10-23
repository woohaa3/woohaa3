import { scopedCanvas, currentCanvasGroupScope } from "./group-scope.js";
/**
 * Canvas Agent 内部能力服务
 * （change: add-agent-canvas-authoring-mcp，任务 2.3 / 3.2 / 3.5 / 4.7 / 5.1）。
 *
 * 把授权、画布发现、published graph 读取、有界增量与计划提交组合为 MCP Service 可调用的
 * 内部能力面。所有读写在**读取节点/生成计划/产生写入之前**先做授权判定（design D11）。
 *
 * 不 import MCP 实现、不缓存权威 snapshot、不触碰 Yjs/task/media 实现。
 */
import {
  AGENT_CANVAS_PROTOCOL_VERSION,
  buildAgentDelta,
  buildResetDelta,
  projectAgentGraph,
  AGENT_CANVAS_LIMITS,
  canvasScriptError,
  canvasScriptApiDescriptor,
  type AgentCanvasGraph
} from "@woohaa3/contracts";
import type { CanvasRoom } from "../sync/index.js";
import type { AgentDeltaJournal } from "./delta-journal.js";
import type { CanvasAuthorizer, CanvasDirectory } from "./authorization.js";
import { AgentCanvasAuthoringService, type AgentApplyInput, type AgentApplyOutcome } from "./service.js";
import type { CanvasScriptService } from "../canvas-script/service.js";

export type AgentCanvasReadDependencies = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  directory: CanvasDirectory;
  authorizer: CanvasAuthorizer;
  journal: AgentDeltaJournal;
  authoring: AgentCanvasAuthoringService;
  /** Canvas script 能力面；未装配时脚本路由返回明确 unavailable（fail-closed）。 */
  script?: CanvasScriptService;
  /** 旧客户端省略 canvasId 时的显式默认画布；仅 loopback 开发提供。 */
  defaultCanvasId?: string;
};

export type AgentGraphReadOutcome =
  | { ok: true; graph: AgentCanvasGraph }
  | { ok: false; code: string; message: string; currentRevision?: number };

export class AgentCanvasInternalService {
  runAdapter?: import("./run-adapter.js").AgentRunAdapter;
  private readonly deps: AgentCanvasReadDependencies;

  constructor(deps: AgentCanvasReadDependencies) {
    this.deps = deps;
  }

  async listCanvases(input: { principalId: string; cursor?: string; limit?: number }) {
    const page = await this.deps.directory.list({
      principalId: input.principalId,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {})
    });
    return page;
  }

  async readGraph(input: {
    principalId: string;
    canvasId?: string;
    parentId?: string | null;
    nodeIds?: string[];
    aroundNodeId?: string;
    depth?: number;
    includePrompt?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<AgentGraphReadOutcome> {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const authorized = await this.authorize(input.principalId, resolved.canvasId, "read");
    if (!authorized.ok) return authorized;

    const room = await this.deps.resolveRoom(resolved.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${resolved.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    const projected = projectAgentGraph(scopedCanvas(exported.canvas), {
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
      ...(input.aroundNodeId ? { aroundNodeId: input.aroundNodeId } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.includePrompt !== undefined ? { includePrompt: input.includePrompt } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {})
    });
    if (!projected.ok) {
      return { ok: false, code: projected.code, message: projected.message, currentRevision: projected.currentRevision };
    }
    return { ok: true, graph: { ...projected.graph, ...(currentCanvasGroupScope() ? { rootGroupId: currentCanvasGroupScope()!.rootGroupId } : {}) } };
  }

  async readChanges(input: { principalId: string; canvasId?: string; sinceRevision: number; limit?: number }) {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const authorized = await this.authorize(input.principalId, resolved.canvasId, "read");
    if (!authorized.ok) return authorized;

    const room = await this.deps.resolveRoom(resolved.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${resolved.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const canvas = scopedCanvas(exported.canvas);
    if (input.sinceRevision > canvas.revision) {
      return { ok: false, code: "malformed-request", message: "sinceRevision 大于当前 revision", currentRevision: canvas.revision };
    }
    // change: 2026-10-22-remove-agent-execution-limits，任务 4.2：删除增量按节点/边/响应字符
    // 总量拒绝。同一 published snapshot 的增量完整返回；确实不可恢复时才返回 resetRequired。
    if (currentCanvasGroupScope()) {
      return { ok: true as const, delta: buildResetDelta(canvas, input.sinceRevision) };
    }
    this.deps.journal.seed(resolved.canvasId);
    const payload = this.deps.journal.deltaFor(resolved.canvasId, input.sinceRevision, canvas.revision);
    const delta = payload
      ? buildAgentDelta(canvas, input.sinceRevision, payload)
      : buildResetDelta(canvas, input.sinceRevision);
    return { ok: true, delta };
  }

  async apply(input: Omit<AgentApplyInput, "canvasId"> & { canvasId?: string; principalId: string }): Promise<AgentApplyOutcome> {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const authorized = await this.authorize(input.principalId, resolved.canvasId, "write");
    if (!authorized.ok) return authorized;
    // 省略 canvasId 时把解析结果补回，保证下游用同一画布。
    return this.deps.authoring.apply({ ...input, canvasId: resolved.canvasId });
  }

  /**
   * Canvas script 能力发现（change: 2026-10-13-add-canvas-script-authoring，任务 4.3）。
   *
   * 解析默认画布并做**读**授权；脚本能力不可用时返回 `available:false` 及原因，
   * 不以普通 JS 执行或内存回执静默替代。
   */
  async scriptCapability(input: { principalId: string; canvasId?: string }): Promise<
    | { ok: true; available: boolean; descriptor?: ReturnType<typeof canvasScriptApiDescriptor>; nodeKinds?: ReturnType<CanvasScriptService["availableNodeKinds"]>; reason?: string }
    | { ok: false; code: string; message: string }
  > {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const authorized = await this.authorize(input.principalId, resolved.canvasId, "read");
    if (!authorized.ok) return authorized;
    const script = this.deps.script;
    if (!script) return { ok: true, available: false, reason: "Canvas script 能力未装配" };
    const capability = script.capability();
    if (!capability.available) return { ok: true, available: false, reason: capability.reason };
    return {
      ok: true,
      available: true,
      descriptor: canvasScriptApiDescriptor(),
      nodeKinds: script.availableNodeKinds()
    };
  }

  /** 脚本预检（任务 4.1）：解析默认画布后交给 Canvas script service（其再次做读写授权）。 */
  async validateScript(input: {
    principalId: string;
    canvasId?: string;
    requestId: string;
    version: string;
    source: string;
    expectedRevision?: number;
  }) {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const script = this.deps.script;
    if (!script) return { ok: false as const, error: unavailableScriptError() };
    return script.validate({
      principalId: input.principalId,
      canvasId: resolved.canvasId,
      requestId: input.requestId,
      version: input.version,
      source: input.source,
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
    });
  }

  /** 脚本提交（任务 4.2）：解析默认画布后交给 Canvas script service（其再次做读写与范围授权）。 */
  async submitScript(input: {
    principalId: string;
    canvasId?: string;
    requestId: string;
    version: string;
    source: string;
    expectedRevision?: number;
  }) {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const script = this.deps.script;
    if (!script) return { ok: false as const, error: unavailableScriptError() };
    return script.submit({
      principalId: input.principalId,
      canvasId: resolved.canvasId,
      requestId: input.requestId,
      version: input.version,
      source: input.source,
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
    });
  }

  /** 由 composition 在 room 提交后调用，维护有界增量日志。 */
  recordDelta(canvasId: string, before: Parameters<AgentDeltaJournal["record"]>[1], after: Parameters<AgentDeltaJournal["record"]>[2]): void {
    this.deps.journal.record(canvasId, before, after);
  }

  /**
   * run 系列路由复用的 canvasId 解析与授权（与 read/write 工具同一判定）。
   * 返回解析后的 canvasId，供 run adapter 使用，避免两套授权逻辑。
   */
  async authorizeCanvas(input: {
    principalId: string;
    canvasId?: string;
    permission: "read" | "write";
  }): Promise<{ ok: true; canvasId: string } | { ok: false; code: string; message: string }> {
    const resolved = this.resolveCanvasId(input.canvasId);
    if (!resolved.ok) return resolved;
    const authorized = await this.authorize(input.principalId, resolved.canvasId, input.permission);
    if (!authorized.ok) return authorized;
    return { ok: true, canvasId: resolved.canvasId };
  }

  private resolveCanvasId(canvasId: string | undefined): { ok: true; canvasId: string } | { ok: false; code: string; message: string } {
    const value = canvasId?.trim() ?? "";
    if (value !== "") return { ok: true, canvasId: value };
    if (this.deps.defaultCanvasId) return { ok: true, canvasId: this.deps.defaultCanvasId };
    return { ok: false, code: "malformed-request", message: "缺少 canvasId（未配置默认画布）" };
  }

  private async authorize(principalId: string, canvasId: string, permission: "read" | "write") {
    if (this.deps.accessRuntime?.enabled !== false && principalId.trim() === "") {
      return { ok: false as const, code: "unauthorized", message: "缺少已认证 principal" };
    }
    const scope = currentCanvasGroupScope();
    if (scope && (!scope.valid() || scope.canvasId !== canvasId)) return { ok: false as const, code: "group-scope-revoked", message: "组创作授权已撤销" };
    const decision = await this.deps.authorizer.authorize({ principalId: scope?.owner ?? principalId, canvasId, permission });
    if (!decision.allowed) return { ok: false as const, code: "forbidden", message: decision.reason };
    return { ok: true as const };
  }
}

/** 脚本能力未装配时的稳定错误（fail-closed，不静默替代）。 */
function unavailableScriptError() {
  return canvasScriptError("script-unavailable", "decode", "Canvas script 能力未装配");
}

/**
 * 能力响应的事实源（任务 5.1）：节点种类、limits、placement、operations。
 */
export function agentCapabilitiesFor(
  nodeKinds: Array<{ kind: string; canonicalType: string; label: string; supportsPrompt: boolean; executable: boolean; defaultSize: { width: number; height: number } }>,
  run: { available: boolean; reason?: string }
) {
  return {
    protocolVersion: AGENT_CANVAS_PROTOCOL_VERSION,
    nodeKinds,
    operations: ["create_node", "connect", "set_prompt", "move_node", "delete", "create_group", "reparent", "ungroup", "set_title", "layout"] as const,
    placementModes: ["absolute", "auto", "after", "before", "below"] as const,
    limits: AGENT_CANVAS_LIMITS,
    run
  };
}
