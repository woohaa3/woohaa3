/**
 * U02：从浏览器剪贴板取图像字节（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 为什么要单独一个文件：`navigator.clipboard.read()` 在各种环境下的失败原因**语义完全不同**
 * （不支持、未授权、剪贴板为空、只有文本没有图像），spec 要求「拒绝或取消当前操作并说明具体
 * 原因」，所以必须把这些情况分开报告，而不是统一抛一个「读取失败」。
 *
 * 边界说明：这里只读取用户当前剪贴板里的**字节**，不读剪贴板历史、不申请持久权限、不把文件名
 * 当成路径。宿主的共享端口（`ports.ts`）归集成负责人；本模块是域内自足的降级实现，宿主提供了
 * 自己的读取端口时可以直接替换本模块而不改面板语义。
 */

/** 剪贴板读取失败的分类；`message` 直接面向用户。 */
export type ClipboardImageFailure = { ok: false; reason: ClipboardFailureReason; message: string };
export type ClipboardFailureReason =
  /** 运行环境没有异步剪贴板 API（旧浏览器、非安全上下文、测试环境）。 */
  | "unsupported"
  /** 用户/浏览器拒绝了读取权限。 */
  | "denied"
  /** 剪贴板里没有图像项（可能为空，或只有文本）。 */
  | "empty"
  /** 取到了图像项但读不出字节。 */
  | "unreadable";

export type ClipboardImageResult = { ok: true; bytes: Uint8Array; label: string } | ClipboardImageFailure;

/** 剪贴板项的最小结构（只依赖用到的字段，便于测试注入）。 */
export type ClipboardItemLike = {
  types: readonly string[];
  getType(type: string): Promise<Blob>;
};

export type ClipboardLike = { read(): Promise<readonly ClipboardItemLike[]> };

/** 注入口（宿主可注入自己的受控实现；缺省读 `navigator.clipboard`）。 */
export type ClipboardHost = { clipboard?: ClipboardLike };

/** 浏览器支持的、我们真正能交给解码器的图像 MIME。 */
const CLIPBOARD_IMAGE_TYPES = ["image/png", "image/tiff", "image/bmp", "image/webp", "image/jpeg", "image/gif"] as const;

function failure(reason: ClipboardFailureReason, message: string): ClipboardImageFailure {
  return { ok: false, reason, message };
}

/** 取异步剪贴板对象；不存在时返回 null（不抛异常，便于在精简宿主里安全调用）。 */
function clipboardOf(host: ClipboardHost | undefined): ClipboardLike | null {
  const source = host ?? (typeof navigator === "undefined" ? undefined : (navigator as { clipboard?: ClipboardLike }));
  const clipboard = source?.clipboard;
  return clipboard && typeof clipboard.read === "function" ? clipboard : null;
}

/**
 * 读取剪贴板中的第一张图像。
 *
 * 失败一定给出可区分的原因：这直接决定界面提示是「换浏览器」「去授权」「先复制一张图」还是
 * 「这张图读不出来」，也决定用户下一步该做什么。
 */
export async function readClipboardImage(host?: ClipboardHost): Promise<ClipboardImageResult> {
  const clipboard = clipboardOf(host);
  if (!clipboard) {
    return failure(
      "unsupported",
      "当前环境不支持读取剪贴板图像（需要安全上下文与异步剪贴板 API）；请改用「选择图像文件」"
    );
  }

  let items: readonly ClipboardItemLike[];
  try {
    items = await clipboard.read();
  } catch (cause) {
    // NotAllowedError 是权限拒绝；其它错误（如无权限策略）同样不能被当成「剪贴板为空」。
    const name = cause instanceof Error ? cause.name : "";
    return failure(
      "denied",
      name === "NotAllowedError"
        ? "浏览器拒绝了剪贴板读取权限；请允许访问后重试，或改用「选择图像文件」"
        : `读取剪贴板被拒绝（${cause instanceof Error ? cause.message : String(cause)}）；请改用「选择图像文件」`
    );
  }

  for (const item of items ?? []) {
    const type = CLIPBOARD_IMAGE_TYPES.find((candidate) => item.types.includes(candidate));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0) continue;
      // 名称只做展示：不放宽成路径权限，也不假设扩展名与内容一致（解码器按内容嗅探）。
      return { ok: true, bytes, label: `剪贴板图像.${type.slice("image/".length)}` };
    } catch {
      return failure("unreadable", "剪贴板里的图像读取失败；请重新复制后重试，或改用「选择图像文件」");
    }
  }

  return failure("empty", "剪贴板里没有图像（可能为空或只有文本）；请先复制一张图像，或改用「选择图像文件」");
}
