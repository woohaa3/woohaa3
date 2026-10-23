/**
 * U02/U03：把本域生成的工程字节真正交付到用户手里
 * （change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 为什么本域需要这一层：`duplicateDocument` 返回的是**自包含工程字节**，但真实装配里
 * 没有任何提供者接住它（`onDuplicate` 可选、无人传入），于是「复制整份文档」会生成
 * 字节却丢掉——按钮可用、结果不可达。这里沿用同包既有的本地下载约定
 * （`features/smart` 的「导出子工程」、`layer-style-pattern-library` 同形）。
 *
 * 语义边界：浏览器只能发起下载，**不能**声称已经写盘。所以这里只做交付，
 * 不动保存基线、不清除 dirty、不写「已保存」。宿主若提供了受控的本地文件端口
 * （`EditorFilePort`），应优先走那条路径；本函数是浏览器形态的降级实现。
 */

/** 把字节作为一次本地下载交付；环境不支持时返回原因而不是抛错。 */
export function downloadBytes(
  bytes: Uint8Array,
  fileName: string
): { ok: true } | { ok: false; reason: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { ok: false, reason: "没有可交付的字节" };
  }
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return { ok: false, reason: "当前环境不支持本地下载，请改用宿主的文件保存入口" };
  }
  try {
    // 复制一份独立 buffer：`Uint8Array` 可能是更大 buffer 的视图，直接传会让 Blob 带上多余字节。
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: `本地下载失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** 副本文件名：用用户给的名字，缺省回落到稳定的默认名；不把用户输入当路径。 */
export function projectFileName(rawName: string, fallback = "photocraft-副本"): string {
  // 只取最后一段，去掉路径分隔符与控制字符，避免把 `/`、`\` 或 NUL 带进下载名。
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const stem = cleaned.length > 0 ? cleaned : fallback;
  return stem.toLowerCase().endsWith(".pcraft") ? stem : `${stem}.pcraft`;
}
