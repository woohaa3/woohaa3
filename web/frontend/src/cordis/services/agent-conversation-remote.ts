/**
 * 宿主 Agent 会话前端 remote adapter
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.6 / design D1/D2/D6a）。
 *
 * 浏览器访问宿主通用会话路由（`/api/agent-conversations/*`）的**唯一**出口：目录/授权/能力、
 * 创建/列出/读取会话、接受回合（异步 dispatch）、按 requestId 查询/取消/关联。
 *
 * 打开/关闭/查询只读：**不**重新 accept 或 dispatch；接受回合之后不阻塞轮询，状态由连续
 * 查询（cursor 增量）收敛。传输复用宿主 `ApplicationRemoteTransport`，不自建 fetch/SSE。
 */
import type {
  AgentCatalogResponse,
  AgentConnectionView,
  AgentEntryIntent,
  AgentMcpStatusResponse,
  ConversationSnapshot,
  ConversationSummary,
  ConversationTurn
} from "@woohaa3/contracts";
import { AGENT_CONVERSATION_BASE_PATH } from "./paths.js";
import type { ApplicationRemoteTransport, ApplicationTransportJsonResult } from "../contract/remote.js";

export type AgentConversationRemote = {
  listServiceConnections?: () => Promise<AgentConversationResult<import("@woohaa3/contracts").ServiceConnectionDirectory>>;
  manageServiceConnection?: (input: import("@woohaa3/contracts").ServiceConnectionManagement) => Promise<AgentConversationResult<{ connection: import("@woohaa3/contracts").ServiceConnectionView }>>;
  catalog: (adapterId?: string) => Promise<AgentConversationResult<AgentCatalogResponse>>;
  /**
   * 该 owner 可见的来源连接（不含秘密；change: 2026-10-16-...，任务 2.4）。
   *
   * 只读；`adapterId` 提供时只返回该来源的连接。不缓存 capability 结果。
   */
  listConnections: (adapterId?: string) => Promise<AgentConversationResult<{ connections: AgentConnectionView[] }>>;
  /** 内置 MCP 真实发现 + 外部连接指引（宿主投影；复制不等于外部已连接）。 */
  mcpStatus: () => Promise<AgentConversationResult<AgentMcpStatusResponse>>;
  list: (canvasId: string) => Promise<AgentConversationResult<{ conversations: ConversationSummary[] }>>;
  create: (input: { canvasId: string; adapterId?: string; title?: string; nodeId?: string; connectionId?: string }) => Promise<AgentConversationResult<{ conversation: ConversationSummary }>>;
  /**
   * 该节点当前会话（一个节点复用一条；design D8）。无则 `conversation: null`（调用方据此新建）。
   *
   * `connectionId` 提供时只返回该来源连接下的会话（change: 2026-10-16-...，任务 2.3）。
   */
  findForTarget: (canvasId: string, nodeId: string, connectionId?: string) => Promise<AgentConversationResult<{ conversation: ConversationSummary | null }>>;
  /** 清空节点上下文：解除关联、归档旧会话（不删除历史）。 */
  clearContext: (canvasId: string, nodeId: string) => Promise<AgentConversationResult<{ ok: true; cleared: number }>>;
  /**
   * 显式切换来源连接：解除目标关联、归档旧会话（保留历史）。活动回合由后端拒绝
   * （change: 2026-10-16-...，任务 2.3）。
   */
  switchConnection: (input: { canvasId: string; nodeId: string; connectionId: string }) => Promise<AgentConversationResult<{ ok: true; cleared: number }>>;
  read: (conversationId: string, cursor?: number) => Promise<AgentConversationResult<ConversationSnapshot>>;
  accept: (conversationId: string, input: { requestId: string; entry: AgentEntryIntent }) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn; reused: boolean }>>;
  query: (requestId: string) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }>>;
  /**
   * 按领域运行关联定位确切回合（活动/历史 Agent 记录 → 确切 request/run）
   * （change: 2026-10-12-add-agent-conversation-panel，任务 5.7 / design D7）。
   *
   * 只匹配已显式关联的 runId，绝不按 nodeId 跳到最近会话；无关联时返回 not-found 让调用方
   * 回退到原任务详情。只读，不 accept/dispatch。
   */
  locate: (runId: string) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }>>;
  retryTextSave?: (requestId: string) => Promise<AgentConversationResult<{ turn: ConversationTurn }>>;
  cancel: (requestId: string) => Promise<AgentConversationResult<{ ok: true }>>;
  link: (requestId: string, input: { runId?: string; taskId?: string }) => Promise<AgentConversationResult<{ turn: ConversationTurn }>>;
};

export type AgentConversationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

export type AgentConversationRemoteOptions = {
  /** 同源业务前缀（缺省 `/api/agent-conversations`）；测试可注入。 */
  basePath?: string;
  /** 通用 Application Remote 传输（必填；生产由宿主在 extension scope 注入）。 */
  transport: ApplicationRemoteTransport;
};

export function createAgentConversationRemote(options: AgentConversationRemoteOptions): AgentConversationRemote {
  const basePath = (options.basePath ?? AGENT_CONVERSATION_BASE_PATH).replace(/\/$/, "");
  const transport = options.transport;

  const unwrap = <T>(result: ApplicationTransportJsonResult): AgentConversationResult<T> => {
    if (!result.ok) return { ok: false, code: result.code ?? "unavailable", error: result.error };
    return { ok: true, value: result.data as T };
  };

  const path = (suffix: string) => `${basePath}/${suffix}`;

  return {
    async catalog(adapterId) {
      const query = adapterId ? `?adapterId=${encodeURIComponent(adapterId)}` : "";
      return unwrap<AgentCatalogResponse>(await transport.request({ path: path(`catalog${query}`), method: "GET" }));
    },
    async manageServiceConnection(input) {
      const { action, ...body } = input;
      return unwrap(await transport.request({ path: path(`service-connections/${action}`), method: "POST", body }));
    },
    async listServiceConnections() {
      return unwrap(await transport.request({ path: path("service-connections"), method: "GET" }));
    },
    async listConnections(adapterId) {
      const query = adapterId ? `?adapterId=${encodeURIComponent(adapterId)}` : "";
      return unwrap(await transport.request({ path: path(`connections${query}`), method: "GET" }));
    },
    async mcpStatus() {
      return unwrap<AgentMcpStatusResponse>(await transport.request({ path: path("mcp"), method: "GET" }));
    },
    async list(canvasId) {
      return unwrap(await transport.request({ path: path(`conversations?canvasId=${encodeURIComponent(canvasId)}`), method: "GET" }));
    },
    async create(input) {
      return unwrap(await transport.request({ path: path("conversations"), method: "POST", body: input }));
    },
    async findForTarget(canvasId, nodeId, connectionId) {
      const query = `canvasId=${encodeURIComponent(canvasId)}&nodeId=${encodeURIComponent(nodeId)}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}`;
      return unwrap(await transport.request({ path: path(`target?${query}`), method: "GET" }));
    },
    async clearContext(canvasId, nodeId) {
      return unwrap(await transport.request({ path: path("context/clear"), method: "POST", body: { canvasId, nodeId } }));
    },
    async switchConnection(input) {
      return unwrap(await transport.request({ path: path("context/switch"), method: "POST", body: input }));
    },
    async read(conversationId, cursor) {
      const query = cursor !== undefined ? `?cursor=${encodeURIComponent(String(cursor))}` : "";
      return unwrap(await transport.request({ path: path(`conversations/${encodeURIComponent(conversationId)}${query}`), method: "GET" }));
    },
    async accept(conversationId, input) {
      return unwrap(await transport.request({ path: path(`conversations/${encodeURIComponent(conversationId)}/turns`), method: "POST", body: input }));
    },
    async query(requestId) {
      return unwrap(await transport.request({ path: path(`turns/${encodeURIComponent(requestId)}`), method: "GET" }));
    },
    async locate(runId) {
      return unwrap(await transport.request({ path: path(`locate?runId=${encodeURIComponent(runId)}`), method: "GET" }));
    },
    async retryTextSave(requestId) {
      const result = unwrap(await transport.request({ path: path(`turns/${encodeURIComponent(requestId)}/retry-save`), method: "POST", body: {} }));
      return result as AgentConversationResult<{ turn: ConversationTurn }>;
    },
    async cancel(requestId) {
      return unwrap(await transport.request({ path: path(`turns/${encodeURIComponent(requestId)}/cancel`), method: "POST", body: {} }));
    },
    async link(requestId, input) {
      return unwrap(await transport.request({ path: path(`turns/${encodeURIComponent(requestId)}/link`), method: "POST", body: input }));
    }
  };
}
