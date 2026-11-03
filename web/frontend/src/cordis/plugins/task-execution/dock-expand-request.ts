/**
 * 「请把这个节点的底部对话框展开」的一次性请求。
 *
 * 底边栏默认收成一条（`DockedBar`），状态在它自己手里；外部动作（例如悬停胶囊「添加到对话框」）
 * 想让用户立刻看到对话框，只能发一个请求。请求按节点记，两种到达顺序都要接住：
 * - 面板已经挂着（把图连进当前面板）→ 订阅者立即收到；
 * - 面板还没挂（新建节点后才被选中、才挂载）→ 挂载时 `peek` / `consume` 读到。
 *
 * 请求有有效期：对应面板始终没出现（提交失败、被别的选择顶掉）时，过期后不再影响之后的展开态。
 */
const TTL_MS = 5000;

const pending = new Map<string, number>();
const listeners = new Set<(nodeId: string) => void>();

function alive(nodeId: string, now: number): boolean {
  const at = pending.get(nodeId);
  if (at === undefined) return false;
  if (now - at > TTL_MS) {
    pending.delete(nodeId);
    return false;
  }
  return true;
}

export function requestDockExpand(nodeId: string, now: number = Date.now()): void {
  pending.set(nodeId, now);
  for (const listener of listeners) listener(nodeId);
}

/** 只看不取：给 `useState` 初始值用（StrictMode 会调两次初始化函数，不能在里面消费）。 */
export function peekDockExpand(nodeId: string, now: number = Date.now()): boolean {
  return alive(nodeId, now);
}

/** 取走：有有效请求返回 true 并清掉。 */
export function consumeDockExpand(nodeId: string, now: number = Date.now()): boolean {
  const ok = alive(nodeId, now);
  pending.delete(nodeId);
  return ok;
}

export function subscribeDockExpand(listener: (nodeId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅测试：清空状态。 */
export function resetDockExpandRequests(): void {
  pending.clear();
  listeners.clear();
}
