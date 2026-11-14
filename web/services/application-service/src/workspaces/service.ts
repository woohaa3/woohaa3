import {
  decodePreparedAgentRoleTurn, preparedTurnHash, stripPreparedHash,
  type CanvasWorkspaceHandle, type CanvasWorkspaceSettings,
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
    store: AgentConversationStore;
    authorize: (identity: { owner: string; canvasId: string }) => Promise<boolean>;
  }) { this.client = createExecutorClient(options.runtime); }

  async prepare(identity: Identity, prepared: PreparedAgentRoleTurn, harnessSupportsWorkspace: boolean): Promise<PreparedAgentRoleTurn> {
    if (prepared.workspace) {
      if (!harnessSupportsWorkspace || !(await this.options.authorize(identity))) reject("当前通道或画布不再允许本机工作目录");
      if (prepared.workspace.owner !== identity.owner || prepared.workspace.canvasId !== identity.canvasId || prepared.workspace.requestId !== identity.requestId) reject("冻结工作目录与回合不一致");
      return prepared;
    }
    if (!identity.canvasId || !harnessSupportsWorkspace || !(await this.options.authorize(identity))) return prepared;
    const workspace = await this.client.call<CanvasWorkspaceHandle>("workspace.acquire", turnIdentity(identity));
    const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
      ...stripPreparedHash(prepared), workspace,
      messages: [...prepared.messages, { role: "system", content: `本轮 harness 的工作目录是当前画布的本机工作目录。使用 harness 内置的文件读写和命令执行工具完成辅助工作；shared/ 供同画布助手共享，本回合临时文件写入 runs/${workspace.runKey}/。正式画布修改仍通过本轮授权的 Woohaa 工具提交，临时文件路径不代表已导入的媒体资产。` }]
    };
    return { ...body, preparedHash: preparedTurnHash(body) };
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
