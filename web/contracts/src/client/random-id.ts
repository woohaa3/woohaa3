/**
 * 运行期安全的随机 ID（浏览器 + 后端共用）。
 *
 * ## 为什么需要它
 *
 * `crypto.randomUUID()` 只在**安全上下文**（HTTPS、`localhost`、`127.0.0.1`、file://）里存在。
 * 通过局域网 IP 的普通 HTTP 打开页面时（例如 `http://192.168.1.10:4173`，或反代未上 TLS 的
 * 内网部署），`crypto` 对象在，但 `randomUUID` 是 `undefined`，直接调用会
 * `TypeError: crypto.randomUUID is not a function`，表现为整个页面「启动失败」。
 *
 * `context.crypto` 里的 `getRandomValues` **没有**安全上下文限制，所以优先用它生成足够熵；
 * 再不行才退回 `Math.random()`。这里的一致性只要求「同一进程/页面内不撞」，不用于密码学用途。
 *
 * 仓库里此前有多处各自写了一版降级（`canvas-session` 的 telemetry 会话 ID、
 * `contracts/client/rules` 的默认 ID、`node-factory` 的高熵后缀），但没覆盖全部调用点，
 * 于是仍有裸调用漏到线上。这里是唯一实现，新代码一律用它。
 */

/** 32 位小写十六进制；不可用高熵源时退回时间戳 + 随机，保证单调且碰撞概率极低。 */
export function randomIdHex(bytes = 16): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const buffer = new Uint8Array(bytes);
    webCrypto.getRandomValues(buffer);
    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 兼容 `crypto.randomUUID()` 调用形状的 ID（带连字符的 UUID v4 样式）。
 *
 * 优先真实 `randomUUID`（可用时保留原生实现），否则用 `getRandomValues` 拼一个 v4 形状：
 * 调用方常把它写进 `commandId` / `requestId` 这类需要稳定格式的字段，形状一致便于排查。
 */
export function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const hex = randomIdHex(16);
  // v4 形状：版本位 4，变体位 8/9/a/b。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${
    "89ab"[Number.parseInt(hex[16] ?? "0", 16) & 0x3]
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
