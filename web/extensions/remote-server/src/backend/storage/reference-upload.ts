/**
 * 参考输入的落点选择：画布托管对象优先，主体命名空间兜底。
 *
 * 背景：画布在远端时，参考图往往**已经**是该画布的托管对象
 * （`<canvasId>/media/<logicalKey>`，由画布媒体写入或历史生成结果产生）。旧实现无条件
 * 把字节复制到 `actor/<sha256(subject)>/media/reference-inputs/<name>`，于是任务只记一个
 * 主体命名空间的 locator：
 * 1. 同一份字节在对象存储里存了两份；
 * 2. 管理端只能按画布作用域签读，任务详情里这条输入就变成「没有存储键」，明明画布里的
 *    原对象可以正常签出来。
 *
 * 因此先问画布后端「这个键在不在、大小是否一致」：命中就复用它的 locator（不复制）。
 * 只有本地独有、还没进远端的字节才回退到主体命名空间——那类输入管理端按设计不签内容
 * 地址，任务记录里保持为空是诚实的。
 */
import { createHash } from "node:crypto";
import type { StorageBackend } from "@woohaa3/contracts";

/** provider 上传钩子交来的参考素材（与 GenerationProvider.uploadReference 的入参同形）。 */
export type ReferenceUploadInput = {
  bytes: Uint8Array;
  contentType: string;
  canvasId?: string;
  storageKey?: string;
};

export type ReferenceUploadDeps = {
  /** 画布托管存储后端：head / put / locatorOf 都在它上面。 */
  backend: Pick<StorageBackend, "head" | "put" | "locatorOf">;
  /** 已登录主体；空串表示没有会话（返回 undefined，由 provider 收敛成稳定失败）。 */
  subject: string;
};

/**
 * 返回参考字节在服务端的 locator；没有会话时返回 undefined。
 *
 * 画布键布局是 `<canvasId>/<namespace>/<logicalKey>`，参考输入固定落在 media 命名空间，
 * 与 core storage 的 `bucket("media", scope)` 同口径（见 web/backend/src/host/core/storage.ts）。
 */
export async function uploadReference(
  deps: ReferenceUploadDeps,
  input: ReferenceUploadInput
): Promise<string | undefined> {
  const canvasId = input.canvasId?.trim() ?? "";
  const storageKey = input.storageKey?.trim() ?? "";
  if (canvasId !== "" && storageKey !== "") {
    const canvasKey = `${canvasId}/media/${storageKey}`;
    try {
      const existing = await deps.backend.head(canvasKey);
      // 只认字节数一致的已有对象：同名但内容不同（本地改过、还没同步）时必须重新上传，
      // 否则会把旧内容当成这次任务的参考图。
      if (existing !== null && existing.size === input.bytes.byteLength) {
        const locator = await deps.backend.locatorOf?.(canvasKey);
        if (locator !== undefined && locator !== "") return locator;
      }
    } catch {
      // 探测失败（未连接、无读权限、旧服务端没有 HeadObject）不是提交失败：
      // 回退到下面的上传路径，别把「查不到」伪装成「素材不存在」。
    }
  }

  const subject = deps.subject;
  if (subject === "") return undefined;
  const actorSegment = createHash("sha256").update(subject).digest("hex");
  // 生成结果这类内容寻址的键，文件名本身就是 sha256；没有稳定键时才按字节现算。
  const name = storageKey !== ""
    ? storageKey.split("/").pop() as string
    : createHash("sha256").update(input.bytes).digest("hex");
  const actorKey = `actor/${actorSegment}/media/reference-inputs/${name}`;
  await deps.backend.put(actorKey, input.bytes, input.contentType, undefined);
  return deps.backend.locatorOf ? await deps.backend.locatorOf(actorKey, undefined) : undefined;
}
