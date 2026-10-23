/**
 * Agent 工具容量与读取分页参数
 * （change: add-agent-canvas-authoring-mcp，任务 2.5 / 5.6；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 3.4 / design D3）。
 *
 * 这里**不再**有按 (principal, canvas, tool) 的固定窗口调用频率或响应字符总量拒绝：合法 Agent
 * 工作不因一分钟内的调用次数、或一次较大响应而被应用限流。真正的副作用边界仍是权限、schema 与
 * 领域校验；资源等待由可查询、可取消的实际调度状态表达。
 *
 * 保留的数值只是实现调度/传输的分页参数（缓存 key 上界、单页大小），不是可拒绝完整工作的额度。
 */

/** 分页与内存有界参数（不产生拒绝路径）。 */
export const AGENT_PAGING = {
  /** 单页 graph 节点数（传输参数；可继续读取）。 */
  graphPageSize: 200,
  /** 分页 key 维度上限（防进程内缓存膨胀；不拒绝请求）。 */
  maxKeys: 10_000
} as const;

export type AgentToolCategory = "read" | "write" | "run";

export type AgentLimitDecision = { allowed: true };
