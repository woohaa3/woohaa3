/**
 * 绘画域的工作区会话
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 为什么需要这一层：共享 `EditorWorkspaceController` 的方法表由集成负责人维护，本域不能往里
 * 加方法；但域内面板仍要触达内核。做法是**只经公共端口**：
 *
 * - 内核调用走 `handle.features.painting.*`（`features/painting/wasm-handle.ts` 已声明的绑定）；
 * - 草稿门、`unavailable`/`fail`/`afterWrite` 走共享 `WorkspaceFeatureContext`，因此像素命令
 *   与其它域共用同一份「先结算草稿」和修订/历史同步，不新建第二个文档或历史。
 *
 * 两条命令通道，避免把「偏好」和「像素」混为一谈：
 *
 * - {@link paintCommand}：真正写像素的绘画命令（铅笔、颜色替换、渐变、油漆桶、两种橡皮），
 *   必须有文档、先过草稿门、写后同步视图；
 * - {@link preferenceCommand}：色板、渐变预设、工具预设、对称与工具重置等工具/偏好状态，
 *   不推进文档修订或内容指纹（内核自己保证），因此不调用 `afterWrite`。
 */

import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

/**
 * 写像素的绘画命令。
 *
 * 逐条列出而不是按 `paint.` 前缀放开：`paint.mixerBrush`、双笔刷等未开放能力必须继续被
 * 白名单拒绝（见内核 `command_allowed`）。
 */
export const PAINT_CONTENT_COMMANDS = [
  "paint.pencil",
  "paint.colorReplacement",
  "paint.bucket",
  "paint.gradient",
  "paint.backgroundEraser",
  "paint.magicEraser"
] as const;

export function isPaintContentCommand(id: string): boolean {
  return (PAINT_CONTENT_COMMANDS as readonly string[]).includes(id);
}

/** 写像素：草稿门 → 冻结门 → 命令 → 视图同步（修订/历史只由内核推进一次）。 */
export function paintCommand(this: WorkspaceFeatureContext, id: string, params: unknown): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!isPaintContentCommand(id)) {
    return { ok: false, code: "unsupported-command", message: `${id} 不是绘画像素命令` };
  }
  const blocked = this.blockingDraft();
  if (blocked) return blocked;
  // 导出/保存期与共享 `dispatch()` 同一道冻结门：域里直连内核的写入口也必须在门后。
  const frozen = this.frozen();
  if (frozen) return frozen;
  const result = handle.features.painting.paintingCommand(id, params);
  if (!result.ok) return this.fail(result);
  return this.afterWrite();
}

/** 工具/偏好状态：不写文档，不产生 dirty。 */
export function preferenceCommand(this: WorkspaceFeatureContext, id: string, params: unknown = null): EditorResult<unknown> {
  if (!this.handle) return this.unavailable();
  if (isPaintContentCommand(id)) {
    return { ok: false, code: "unsupported-command", message: `${id} 必须经像素通道提交` };
  }
  const result = this.handle.features.painting.paintingCommand(id, params);
  if (!result.ok) return this.fail(result);
  return result;
}

/** 单工具恢复默认（`tool.reset`）：只改声明的笔刷/工具选项范围。 */
export function resetTool(this: WorkspaceFeatureContext, tool: string): EditorResult<unknown> {
  return preferenceCommand.call(this, "tool.reset", { tool });
}

/** 全部绘画工具恢复默认（`tool.resetAll`）：不动文档与工作区布局。 */
export function resetAllTools(this: WorkspaceFeatureContext): EditorResult<unknown> {
  return preferenceCommand.call(this, "tool.resetAll", {});
}

// ---------------------------------------------------------------- 只读查询

/** 独立吸管（平均采样尺寸 + 采样层策略）。只读：不改修订、历史或内容指纹。 */
export function sampleColorOptions(this: WorkspaceFeatureContext, params: unknown): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.sampleColorOptions(params);
}

/** 当前文档的对称状态；未启用为 `{enabled:false}`。 */
export function symmetryState(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.symmetryState();
}

/** 工具预设清单（可按工具过滤；过滤由内核做，界面不再造一套名字规则）。 */
export function toolPresets(this: WorkspaceFeatureContext, tool = ""): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.toolPresets(tool);
}

/** 保存/覆盖工具预设；`includeColor` 由内核把当前前景色写进 `options`。 */
export function saveToolPreset(this: WorkspaceFeatureContext, params: unknown): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.saveToolPreset(params);
}

/** 应用工具预设：内核套用 `brush`/前景色并返回工具 id。 */
export function selectToolPreset(this: WorkspaceFeatureContext, name: string): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.selectToolPreset(name);
}

/** 改名/删除工具预设（`action: "rename"|"delete"`）。 */
export function editToolPreset(this: WorkspaceFeatureContext, params: unknown): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.editToolPreset(params);
}

/** 恢复内置工具预设（`tool.presets.reset`）——注意与 `tool.resetAll` 不同：只换预设库。 */
export function resetToolPresets(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.resetToolPresets();
}

/** 工具预设快照字节（宿主偏好存储用）。 */
export function toolPresetSnapshot(this: WorkspaceFeatureContext): EditorResult<Uint8Array> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.toolPresetSnapshot();
}

/** 恢复工具预设快照；坏快照整份拒绝，保留当前库。 */
export function restoreToolPresets(this: WorkspaceFeatureContext, bytes: Uint8Array): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.restoreToolPresets(bytes);
}

// ---------------------------------------------------------------- 笔刷分组与选区笔尖（U32）

export function renameBrushGroup(this: WorkspaceFeatureContext, group: string, newName: string): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.renameBrushGroup(group, newName);
}

export function deleteBrushGroup(this: WorkspaceFeatureContext, group: string, keepPresets: boolean): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.deleteBrushGroup(group, keepPresets);
}

export function moveBrushGroup(this: WorkspaceFeatureContext, group: string, index: number): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.moveBrushGroup(group, index);
}

/** 从当前选区定义静态笔尖；空选区/超预算由内核拒绝。 */
export function defineBrushFromSelection(this: WorkspaceFeatureContext, name: string, group = ""): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.painting.defineBrushFromSelection(name, group);
}

/**
 * 宿主句柄是否提供本域接口。
 *
 * 精简宿主与测试替身可能只有部分端口；缺接口时 panel 不渲染，而不是调用时抛错。
 */
export function paintingAvailable(this: WorkspaceFeatureContext): boolean {
  const features = (this.handle as unknown as { features?: { painting?: unknown } } | null)?.features;
  return !!features?.painting;
}

export function createSession(context: () => WorkspaceFeatureContext) {
  const bind = <A extends unknown[], R>(run: (this: WorkspaceFeatureContext, ...args: A) => R) =>
    (...args: A): R => run.apply(context(), args);
  return {
    available: bind(paintingAvailable),
    paintCommand: bind(paintCommand),
    preferenceCommand: bind(preferenceCommand),
    resetTool: bind(resetTool),
    resetAllTools: bind(resetAllTools),
    sampleColorOptions: bind(sampleColorOptions),
    symmetryState: bind(symmetryState),
    toolPresets: bind(toolPresets),
    saveToolPreset: bind(saveToolPreset),
    selectToolPreset: bind(selectToolPreset),
    editToolPreset: bind(editToolPreset),
    resetToolPresets: bind(resetToolPresets),
    toolPresetSnapshot: bind(toolPresetSnapshot),
    restoreToolPresets: bind(restoreToolPresets),
    renameBrushGroup: bind(renameBrushGroup),
    deleteBrushGroup: bind(deleteBrushGroup),
    moveBrushGroup: bind(moveBrushGroup),
    defineBrushFromSelection: bind(defineBrushFromSelection)
  };
}

/** 面板消费的会话类型（与 `EditorWorkspaceController.features.painting` 同构）。 */
export type PaintingSession = ReturnType<typeof createSession>;
