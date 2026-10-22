/**
 * Paste 事件分派优先级
 * （change: add-paste-import-workflows，任务 1.2 / design D2）。
 *
 * 纯判定：给定剪贴板文本、受支持文件与内部载荷解析结果，返回本次 paste 的处理意图。
 * 实际副作用由 plugin 按意图调用 Canvas Session / Import Service / adapter。
 *
 * 顺序（必须稳定）：
 * 1. `text/plain` 可解析为受支持的内部版本化节点载荷 → 内部节点粘贴；
 * 2. 注册的受控 clipboard adapter 明确接受该结构化 payload → 交给 adapter；
 * 3. DataTransfer 中存在支持的本地文件 → 文件导入；
 * 4. 否则无操作（不阻止浏览器/编辑器的普通文本粘贴）。
 */
import type { CanvasCopyPayload } from "../canvas-shell/clipboard/payload.js";
import { isSupportedMimeType, type ClassifiedFile } from "./datatransfer.js";
import type { ClipboardAdapterRegistry } from "./adapter.js";

export type PasteIntent =
  | { kind: "internal"; payload: CanvasCopyPayload }
  | { kind: "adapter"; files: readonly File[]; source: string }
  | { kind: "files"; files: ClassifiedFile[] }
  | { kind: "none" };

export function resolvePasteIntent(input: {
  text: string | null;
  internalPayload: CanvasCopyPayload | null;
  files: readonly ClassifiedFile[];
  adapters: ClipboardAdapterRegistry;
}): PasteIntent {
  // 1. 内部版本化节点载荷优先级最高；同一次事件里的文件不再重复导入。
  if (input.internalPayload) return { kind: "internal", payload: input.internalPayload };

  // 2. 受控 adapter：只在内部载荷未命中时尝试。
  const resolved = input.adapters.resolve({
    text: input.text,
    internal: input.internalPayload,
    files: input.files.map((entry) => entry.file)
  });
  if (resolved) return { kind: "adapter", files: resolved.plan.files, source: resolved.plan.source };

  // 3. 支持的本地文件。
  if (input.files.length > 0) return { kind: "files", files: [...input.files] };

  // 4. 无操作。
  return { kind: "none" };
}

/** drop 只有文件一种意图；非文件传输为无操作。 */
export function resolveDropIntent(files: readonly ClassifiedFile[]): PasteIntent {
  return files.length > 0 ? { kind: "files", files: [...files] } : { kind: "none" };
}

/**
 * dragover/dragenter 反馈判定：transfer 是否**包含文件**。
 *
 * **关键**：`dragover` 阶段浏览器不暴露文件内容（`files` 为空、`getAsFile()` 返回 null），
 * 只有 `types` 与 `item.kind`/`item.type` 可用。因此这里只判定「是否含文件」而**不**判定
 * 支持类型：
 * - 若在此返回 false 就不 `preventDefault`，浏览器既不会派发 `drop`，还会把文件当导航目标
 *   打开（spec「浏览器默认打开文件的行为 MUST 被阻止」）；
 * - 真正的类型/大小/零字节分类在 `drop` 阶段完成，并给出可诊断拒绝。
 *
 * 纯文本拖放（无 file item 且 `types` 不含 "Files"）返回 false，让浏览器/编辑面处理文本。
 */
export function transferHasFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;

  const items = transfer.items;
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]?.kind === "file") return true;
    }
  }
  const types = transfer.types ? Array.from(transfer.types as ArrayLike<string>) : [];
  return types.includes("Files");
}

/**
 * dragover 阶段是否可能产生**受支持**导入（用于反馈强弱，不做最终判定）。
 * 空 MIME（目录/未知）保守视为可能；drop 阶段再做精确拒绝。
 */
export function transferMayContainSupportedFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  const items = transfer.items;
  let sawFileItem = false;
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind !== "file") continue;
      sawFileItem = true;
      if (isSupportedMimeType(item.type)) return true;
    }
  }
  // 没有任何 file item 明细时，只看 types 的保守回退。
  return !sawFileItem && transferHasFiles(transfer);
}
