import {
  CANVAS_WORKSPACE_TOOLS, decodePreparedAgentRoleTurn, preparedTurnHash, stripPreparedHash,
  type ApplicationToolGrant, type CanvasWorkspaceHandle, type CanvasWorkspaceSettings,
  type PreparedAgentRoleTurn, type WorkspaceMigration
} from "@woohaa3/contracts";
import { createExecutorClient } from "woohaa3-executor/client";
import type { HostRuntimeOptions } from "../extensions/agent-runtime-adapter.js";
import type { AgentConversationStore } from "../repository/agent-conversation-repository.js";
import { isTerminalTurnStatus } from "../repository/agent-conversation-repository.js";

const reject = (message: string): never => { throw Object.assign(new Error(message), { code: "workspace-forbidden" }); };
type Identity = { owner: string; canvasId: string; requestId: string };
const turnIdentity = ({ owner, canvasId, requestId }: Identity): Identity => ({ owner, canvasId, requestId });
/** Host-owned canvas leases; no absolute path or identity is taken from model arguments. */
export class CanvasAgentWorkspaceService {
  private readonly client;
  constructor(private readonly options: {
    runtime: HostRuntimeOptions;
    importArtifact?: (input: { canvasId: string; bytesBase64: string; contentType: string }) => Promise<import("@woohaa3/contracts").MediaMetadata>;
    store: AgentConversationStore;
    authorize: (identity: { owner: string; canvasId: string }) => Promise<boolean>;
  }) { this.client = createExecutorClient(options.runtime); }

  async prepare(identity: Identity, prepared: PreparedAgentRoleTurn, toolsSupported: boolean): Promise<PreparedAgentRoleTurn> {
    if (prepared.workspace) {
      if (prepared.workspace.owner !== identity.owner || prepared.workspace.canvasId !== identity.canvasId || prepared.workspace.requestId !== identity.requestId) reject("冻结工作目录与回合不一致");
      return prepared;
    }
    if (!identity.canvasId || !toolsSupported || !(await this.options.authorize(identity))) return prepared;
    const workspace = await this.client.call<CanvasWorkspaceHandle>("workspace.acquire", turnIdentity(identity));
    const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
      ...stripPreparedHash(prepared), workspace,
      tools: [...new Set([...prepared.tools, ...CANVAS_WORKSPACE_TOOLS])],
      messages: [...prepared.messages, { role: "system", content: `桌面本机辅助工作目录已授权。同画布所有助手共享 shared/；本回合临时目录 runs/${workspace.runKey}/，execute 默认在此目录运行。文件工具路径相对画布目录，临时文件请显式写入本回合目录。Node 使用随包版本；Python 等程序仅在本机已安装时可用。execute 是当前用户账号下的本机执行，cwd 不是操作系统沙箱。不得把临时文件路径当作已导入的画布资产；正式产物须通过资产导入工具。` }]
    };
    return { ...body, preparedHash: preparedTurnHash(body) };
  }
  private record(identity: Identity) {
    const turn = this.options.store.findTurnByRequest(identity.owner, identity.requestId);
    const authority = turn && this.options.store.getTurnAuthority(turn.turnId);
    if (!turn || turn.canvasId !== identity.canvasId || isTerminalTurnStatus(turn.status) || !authority || authority.revokedAt) reject("工作目录回合未授权或已结束");
    return { turn: turn!, authority: authority! };
  }
  async allows(identity: Identity, tools: readonly string[]): Promise<boolean> {
    try {
      const { authority } = this.record(identity);
      if (tools.some(tool => !CANVAS_WORKSPACE_TOOLS.includes(tool as never) || !authority.toolScope?.includes(tool))) return false;
      if (!(await this.options.authorize(identity))) return false;
      await this.client.call("workspace.lookup", turnIdentity(identity));
      return true;
    } catch { return false; }
  }
  async tool(input: { tool: string; arguments: Record<string, unknown>; grant: ApplicationToolGrant; principalId: string }): Promise<unknown> {
    const { grant, principalId, tool, arguments: args } = input;
    if (grant.canvasIds.length !== 1 || !grant.workId || !principalId || grant.subject !== principalId || !grant.tools.includes(tool)) reject("工具授予与工作目录主体不一致");
    const identity = { owner: principalId, canvasId: grant.canvasIds[0]!, requestId: grant.workId };
    if (!(await this.allows(identity, [tool]))) reject("工作目录权限已撤销或回合已结束");
    const handle = await this.client.call<CanvasWorkspaceHandle>("workspace.lookup", identity);
    switch (tool) {
      case "workspace_list": return this.client.call("workspace.list", { handle, path: args.path });
      case "workspace_read": return this.client.call("workspace.read", { handle, path: args.path });
      case "workspace_write": return this.client.call("workspace.write", { handle, input: args });
      case "workspace_mkdir": return this.client.call("workspace.mkdir", { handle, path: args.path });
      case "workspace_import": {
        if (!this.options.importArtifact) throw Object.assign(new Error("资产导入端口不可用"), { code: "workspace-unavailable" });
        const file = await this.client.call<{ bytesBase64: string; fileName: string }>("workspace.assetBytes", { handle, path: args.path });
        // Bytes enter the existing asset service; the temporary path is never an asset identity.
        return this.options.importArtifact({ canvasId: identity.canvasId, bytesBase64: file.bytesBase64, contentType: String(args.contentType) });
      }
      case "workspace_execute": return this.client.call("workspace.execute", { handle, input: args });
      case "workspace_query": return this.client.call("workspace.query", { handle, input: args });
      case "workspace_stop": return this.client.call("workspace.stop", { handle, executionId: args.executionId });
      default: return reject("未知辅助工具");
    }
  }
  cancel(identity: Identity): Promise<void> { return this.client.call("workspace.settle", { ...turnIdentity(identity), outcome: "cancelled" }); }
  async settled(identity: Identity, status: string): Promise<void> {
    const turn = this.options.store.findTurnByRequest(identity.owner, identity.requestId);
    const unknown = /unconfirmed|unknown|interrupted/.test(turn?.errorCode ?? "");
    await this.client.call("workspace.settle", { ...turnIdentity(identity), outcome: unknown ? "unknown" : status === "cancelled" || status === "failed" ? "cancelled" : "terminal" });
  }
  /** Retries durable terminal settlements after host detach/crash; never dispatches work. */
  async reconcile(): Promise<void> {
    const leases = await this.client.call<Array<Identity & { status: string }>>("workspace.leases");
    for (const lease of leases) {
      if (!["active", "unknown"].includes(lease.status)) continue;
      const turn = this.options.store.findTurnByRequest(lease.owner, lease.requestId);
      if (!turn || turn.canvasId !== lease.canvasId) continue;
      if (isTerminalTurnStatus(turn.status)) await this.settled(lease, turn.status);
      else if (lease.status === "unknown" && turn.preparedJson) {
        const authority = this.options.store.getTurnAuthority(turn.turnId);
        let frozen: ReturnType<typeof decodePreparedAgentRoleTurn>;
        try { frozen = decodePreparedAgentRoleTurn(JSON.parse(turn.preparedJson)); } catch { continue; }
        if (!frozen.ok || !frozen.value.workspace || !authority || authority.revokedAt !== null || authority.preparedHash !== frozen.value.preparedHash) continue;
        const h = frozen.value.workspace;
        if (h.owner !== lease.owner || h.canvasId !== lease.canvasId || h.requestId !== lease.requestId) continue;
        if (!(await this.options.authorize(lease))) continue;
        await this.client.call("workspace.settle", { ...turnIdentity(lease), outcome: "active" });
      }
    }
  }
  settings() { return this.client.call<CanvasWorkspaceSettings>("workspace.settings"); }
  location({ owner, canvasId }: { owner: string; canvasId: string }) { return this.client.call<string>("workspace.location", { owner, canvasId }); }
  migrate(input: { operationId: string; targetPath: string; expectedRootRevision: number }) { return this.client.call<WorkspaceMigration>("workspace.migrate", input); }
  cancelMigration(operationId: string) { return this.client.call<WorkspaceMigration>("workspace.cancelMigration", { operationId }); }
  clean({ owner, canvasId }: { owner: string; canvasId: string }) { return this.client.call<{ removed: string[]; retained: string[] }>("workspace.clean", { owner, canvasId }); }
}
