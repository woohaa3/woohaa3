/**
 * MCP 请求可信主体（Backend 侧）
 * （change: 2026-11-01-rebuild-canvas-shared-world-authoring —— 节点组编排身份修复）。
 *
 * MCP 传输在网关按 bearer grant 校验并解析出**可信 owner**（`toolGrants.subject`），本模块
 * 只把该 owner 放进进程内 `AsyncLocalStorage`，供下游适配器（Agent Canvas 客户端）在**同一次
 * 请求内**解析真实 principal，而不是读取静态部署变量。
 *
 * 主体只来自宿主已校验的 grant；工具参数、模型输出与静态环境变量都不得覆盖它。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** 当前 MCP 请求的可信主体；不在 MCP 请求内或该请求无主体时返回 undefined。 */
export function currentMcpPrincipal(): string | undefined {
  return store.getStore();
}

/** 在受信主体作用域内运行一次 MCP 处理（主体来自已验证的 bearer grant）。 */
export function withMcpPrincipal<T>(principal: string, run: () => T): T {
  return store.run(principal, run);
}
