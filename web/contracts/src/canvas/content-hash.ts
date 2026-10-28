/**
 * 内容指纹（FNV-1a 64-bit，hex）
 * （change: optimize-model-scene-snapshot-hot-path）。
 *
 * 无副作用、不依赖 crypto：浏览器、Node 与 Rust 可用同一算法复现。仅用于把规范化 Scene IR
 * 折叠成稳定、紧凑的**资源 key 组成部分**；跨边界注册仍携带完整 descriptor 并拒绝冲突，
 * 因此 hash 碰撞不会导致静默错误复用（design D2）。
 */

/** 计算文本的 FNV-1a 64-bit 指纹（16 位小写 hex）。 */
export function fnv1a64Hex(text: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let i = 0; i < text.length; i += 1) {
    // Preserve the original UTF-16 code-unit XOR, including unpaired surrogates.
    low = (low ^ text.charCodeAt(i)) >>> 0;
    // The FNV prime is 2^40 + 435. low * 435 stays below 2^53,
    // so its carry is exact; only the low 32 bits of the high word survive.
    const product = low * 435;
    high = (Math.imul(high, 435) + (low << 8) + Math.floor(product / 0x100000000)) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * 计算字节序列的 FNV-1a 64-bit 指纹（16 位小写 hex）。
 *
 * 用于内嵌纹理等二进制内容身份（change: 2026-10-28-support-glb-model-nodes）：同一字节序列在
 * 任何入口解析都得到同一 id，跨重载稳定。
 */
export function fnv1a64HexBytes(bytes: Uint8Array): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let i = 0; i < bytes.length; i += 1) {
    low = (low ^ bytes[i]) >>> 0;
    const product = low * 435;
    high = (Math.imul(high, 435) + (low << 8) + Math.floor(product / 0x100000000)) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
