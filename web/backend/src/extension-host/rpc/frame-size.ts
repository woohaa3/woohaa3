/**
 * 帧大小估算（change: 2026-10-21-isolate-extension-host-process，D3）。
 *
 * IPC 用 `serialization: "advanced"`（结构化克隆），没有廉价的精确字节数；这里按 JSON 近似 + 二进制
 * 原长估算。估算偏保守即可：目的是拒发超限帧，而不是计费。循环引用直接按超限处理。
 */
export function estimateFrameBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (total > limit) return total;
    const current = stack.pop();
    if (current === null || current === undefined) {
      total += 4;
    } else if (typeof current === "string") {
      total += current.length * 2 + 2;
    } else if (typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") {
      total += 8;
    } else if (ArrayBuffer.isView(current)) {
      total += current.byteLength;
    } else if (current instanceof ArrayBuffer) {
      total += current.byteLength;
    } else if (typeof current === "object") {
      if (seen.has(current)) return Number.POSITIVE_INFINITY;
      seen.add(current);
      if (Array.isArray(current)) {
        total += 2;
        for (const item of current) stack.push(item);
      } else {
        total += 2;
        for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
          total += key.length * 2 + 4;
          stack.push(item);
        }
      }
    } else {
      // 函数 / symbol 不可跨进程：按超限处理，让调用方在发送前就失败。
      return Number.POSITIVE_INFINITY;
    }
  }
  return total;
}
