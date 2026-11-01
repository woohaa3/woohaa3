/**
 * 画布会话的环境辅助（从 `canvas-session.ts` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`canvas-session.ts` 拆分后恰好停在 800 行的阈值上，任何一次
 * 两行的改动都会让守卫重新变红。这两个函数都是纯的：一个生成会话标识，一个读浏览器
 * 在线状态，不持有会话状态。
 */

/**
 * 一次画布会话的关联标识：32 位小写十六进制，与 trace_id 同形状。
 *
 * 不用 crypto.randomUUID()：它在非安全上下文（局域网 http）里不可用，而画布
 * 完全可能通过这种地址打开。getRandomValues 没有这个限制。
 */
export function createTelemetrySessionId(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 浏览器是否处于系统级断网。
 *
 * Chromium 的 `page.context().setOffline(true)` 不会关闭已建立的 WebSocket，因此仅靠
 * socket 的 close 事件无法感知断网。这里读 `navigator.onLine`——它是产品语义（断线只读）
 * 的正确来源，E2E 与真实用户断网都会置为 false。
 */
export function isBrowserOffline(): boolean {
  const online = (globalThis as unknown as { navigator?: { onLine?: boolean } }).navigator?.onLine;
  return online === false;
}
