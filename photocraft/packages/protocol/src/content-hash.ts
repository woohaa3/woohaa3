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
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
