/**
 * 字节 ↔ base64 的唯一转换（change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 本域所有跨 wasm 边界的字节（ATN、批处理输入/交付、数据集导出）都以 base64 字符串传递：
 * wasm-bindgen 的 `Vec<u8>` 参数在浏览器里仍然要经过一次 `Uint8Array` 拷贝，而 base64 让
 * 「内核返回的文件」与「宿主读到的文件」走同一个形状，面板与测试都不必区分两套编码。
 *
 * 这里不使用 `btoa(String.fromCharCode(...bytes))` 的展开写法：大文件会爆栈。
 */

const CHUNK = 0x8000;

/** 字节 → 标准 base64（无换行）。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return globalThis.btoa(binary);
}

/** 标准 base64 → 字节；非法输入返回 `null`（不抛异常，调用方给出可读错误）。 */
export function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = globalThis.atob(text.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** 交付文件名的主干（去掉最后一个扩展名）。 */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
