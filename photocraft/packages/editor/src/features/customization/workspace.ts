/**
 * 定制域会话（U78）：供工作区控制器/外壳消费的偏好与解析端口
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D2）。
 *
 * 这里只有**纯本机偏好**操作：不读文档、不写内容、不推进修订或历史，因此不经过草稿/保存门禁。
 * 键盘分派与菜单/工具栏渲染仍在共享外壳；外壳按下列端口接入后，偏好才会真正影响按键与菜单
 * （当前接入点不在本域单写目录内，见 change 的集成阻塞项）。
 */
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorPanelLayout } from "../../editor-panel-layout.js";
import type { EditorShortcut } from "../../photo-editor-shortcuts.js";
import {
  defaultCustomizationStore,
  effectiveChord,
  matchCustomizationBinding,
  type CustomizationResult,
  type CustomizationState,
  type ShortcutEventLike,
  type ToolOptionValue,
  type WorkspaceApplyResult
} from "./preferences.js";
import {
  preferredShortcut,
  resolveWithPreferences,
  toolbarToolIds,
  workspacePanelLayout
} from "./shell-adapter.js";

/** 当前偏好快照（只读投影；偏好不进文档内容）。 */
export function customizationState(this: WorkspaceFeatureContext): CustomizationState {
  return defaultCustomizationStore().snapshot();
}

/** 订阅偏好变化；返回取消订阅函数。 */
export function subscribeCustomization(this: WorkspaceFeatureContext, listener: () => void): () => void {
  return defaultCustomizationStore().subscribe(listener);
}

/**
 * 解析一次按键到已绑定动作。
 *
 * 调用方仍须走自己的命令门（`dispatch` 会再校验一次），因此自定义键位不能绕过只读、草稿、
 * 冻结或未开放命令的检查。
 */
export function resolveCustomizationShortcut(
  this: WorkspaceFeatureContext,
  event: ShortcutEventLike,
  isMac: boolean
): { actionId: string; chord: string } | null {
  return matchCustomizationBinding(defaultCustomizationStore().snapshot().preferences, event, isMac);
}

/** 某动作当前生效的组合文本（空串表示未绑定）。 */
export function customizationChord(this: WorkspaceFeatureContext, actionId: string): string {
  return effectiveChord(defaultCustomizationStore().snapshot().preferences, actionId);
}

/**
 * 把一次按键翻译成外壳既有的分派形状（`null` = 本域不认领，回退出厂解析）。
 *
 * 与 `resolveCustomizationShortcut` 的区别：这里已经过 `shell-adapter` 的翻译，外壳可以直接交给
 * 既有的 `applyShortcut`，不需要再写一个按动作 id 分支的实现。
 */
export function preferredCustomizationShortcut(
  this: WorkspaceFeatureContext,
  event: ShortcutEventLike,
  isMac: boolean
): EditorShortcut | null {
  return preferredShortcut(defaultCustomizationStore().snapshot().preferences, event, isMac);
}

/**
 * 完整解析一次按键：偏好优先，出厂兜底，但被用户改掉的出厂组合不再触发。
 *
 * 这是外壳键盘分派**唯一**需要调用的一行：把原来的 `resolveEditorShortcut(event, isMac)`
 * 换成 `controller.features.customization.resolveCustomizationKey(event.nativeEvent, isMac)`，
 * 之后仍走既有 `applyShortcut` 与只读/草稿/IME 门禁。
 */
export function resolveCustomizationKey(
  this: WorkspaceFeatureContext,
  event: ShortcutEventLike,
  isMac: boolean
): EditorShortcut | null {
  return resolveWithPreferences(defaultCustomizationStore().snapshot().preferences, event, isMac);
}

/** 工具栏应渲染的工具 id 顺序（已去掉隐藏项）。 */
export function customizationToolbarOrder(this: WorkspaceFeatureContext): string[] {
  return toolbarToolIds(defaultCustomizationStore().snapshot().preferences);
}

/** 某工具最近记忆的选项；未记忆返回 `null`（不要用空对象覆盖当前值）。 */
export function customizationToolOptions(
  this: WorkspaceFeatureContext,
  tool: string
): Record<string, ToolOptionValue> | null {
  const stored = defaultCustomizationStore().snapshot().preferences.toolOptions[tool];
  return stored && Object.keys(stored).length ? { ...stored } : null;
}

/**
 * 工作区几何 → 布局所有者可用的规范化布局（`null` = 保持当前布局）。
 *
 * 外壳在应用工作区后把结果喂给 `display.updatePanels`，即可免去「重开编辑器后生效」。
 */
export function customizationPanelLayout(
  this: WorkspaceFeatureContext,
  layout: Record<string, unknown> | null,
  current: EditorPanelLayout
): EditorPanelLayout | null {
  return workspacePanelLayout(layout, current);
}

/** 设置快捷键；冲突返回 `conflict`，调用方选择 `force` 覆盖或取消。 */
export function setCustomizationShortcut(this: WorkspaceFeatureContext, actionId: string, chord: string, force = false): CustomizationResult {
  return defaultCustomizationStore().setShortcut(actionId, chord, { force });
}

export function resetCustomizationShortcuts(this: WorkspaceFeatureContext): CustomizationResult {
  return defaultCustomizationStore().resetShortcuts();
}

/** 应用命名工作区；面板几何交回布局所有者（外壳负责重排）。 */
export function applyCustomizationWorkspace(this: WorkspaceFeatureContext, id: string): WorkspaceApplyResult {
  return defaultCustomizationStore().applyWorkspace(id);
}

/** 记录工具面板最近使用的选项（工具状态，不造文档 dirty）。 */
export function rememberCustomizationToolOptions(
  this: WorkspaceFeatureContext,
  tool: string,
  values: Record<string, unknown>
): CustomizationResult {
  return defaultCustomizationStore().rememberToolOptions(tool, values);
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    customizationState: (...args: Parameters<OmitThisParameter<typeof customizationState>>) => customizationState.apply(context(), args),
    subscribeCustomization: (...args: Parameters<OmitThisParameter<typeof subscribeCustomization>>) => subscribeCustomization.apply(context(), args),
    resolveCustomizationShortcut: (...args: Parameters<OmitThisParameter<typeof resolveCustomizationShortcut>>) => resolveCustomizationShortcut.apply(context(), args),
    customizationChord: (...args: Parameters<OmitThisParameter<typeof customizationChord>>) => customizationChord.apply(context(), args),
    preferredCustomizationShortcut: (...args: Parameters<OmitThisParameter<typeof preferredCustomizationShortcut>>) => preferredCustomizationShortcut.apply(context(), args),
    resolveCustomizationKey: (...args: Parameters<OmitThisParameter<typeof resolveCustomizationKey>>) => resolveCustomizationKey.apply(context(), args),
    customizationToolbarOrder: (...args: Parameters<OmitThisParameter<typeof customizationToolbarOrder>>) => customizationToolbarOrder.apply(context(), args),
    customizationToolOptions: (...args: Parameters<OmitThisParameter<typeof customizationToolOptions>>) => customizationToolOptions.apply(context(), args),
    customizationPanelLayout: (...args: Parameters<OmitThisParameter<typeof customizationPanelLayout>>) => customizationPanelLayout.apply(context(), args),
    setCustomizationShortcut: (...args: Parameters<OmitThisParameter<typeof setCustomizationShortcut>>) => setCustomizationShortcut.apply(context(), args),
    resetCustomizationShortcuts: (...args: Parameters<OmitThisParameter<typeof resetCustomizationShortcuts>>) => resetCustomizationShortcuts.apply(context(), args),
    applyCustomizationWorkspace: (...args: Parameters<OmitThisParameter<typeof applyCustomizationWorkspace>>) => applyCustomizationWorkspace.apply(context(), args),
    rememberCustomizationToolOptions: (...args: Parameters<OmitThisParameter<typeof rememberCustomizationToolOptions>>) => rememberCustomizationToolOptions.apply(context(), args)
  };
}
