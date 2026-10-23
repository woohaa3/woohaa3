import { TOOL_GROUPS } from "../tool-groups.js";
/**
 * 外壳接入适配（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D2/D3）。
 *
 * 本模块把本机偏好**翻译成共享外壳已经认识的形状**，让键盘分派、菜单渲染、工具栏渲染、工作区
 * 布局与工具选项恢复都只需在外壳里加一行调用：
 *
 * ```ts
 * // photo-editor-app.tsx 的 onKeyDown：一次调用就同时处理偏好与出厂兜底
 * const action = resolveWithPreferences(preferences, event.nativeEvent, isEditorMac());
 * ```
 *
 * **不要**写成 `preferredShortcut(...) ?? resolveEditorShortcut(...)`：后者在偏好认领不到时一律
 * 回退出厂解析，用户改绑/解绑后的旧组合会继续触发，等于自定义快捷键无效。
 *
 * 这里只有纯函数：不读文档、不写存储、不触碰 DOM。共享外壳仍是唯一的分派/渲染所有者，
 * 本域不复制第二套 `applyShortcut` 或菜单实现。
 */
import type { EditorDisplayAction } from "../../editor-display.js";
import { normalizePanelLayout, type EditorPanelLayout } from "../../editor-panel-layout.js";
import { resolveEditorShortcut, type EditorShortcut, type PhotoEditorTool } from "../../photo-editor-shortcuts.js";
import {
  CUSTOMIZATION_TOOL_ACTIONS,
  chordLabel,
  chordMatchesEvent,
  customizationAction,
  effectiveChord,
  matchCustomizationBinding,
  parseChord,
  type CustomizationPreferences,
  type ShortcutEventLike
} from "./preferences.js";

const TOOL_IDS = new Set(CUSTOMIZATION_TOOL_ACTIONS.map((action) => action.id.slice("tool.".length)));
const DISPLAY_ACTIONS: readonly EditorDisplayAction[] = ["extras", "panels", "sidebar"];

/**
 * 动作 id → 外壳已有的分派形状。
 *
 * 少数动作在既有解析器里不是普通命令（保存、清除、变换、剪贴蒙版开关、视图缩放），这里沿用
 * 同一形状，避免外壳出现「自定义键位能触发、出厂键位走另一个分支」的第二种语义。
 */
const ACTION_ALIASES: Readonly<Record<string, EditorShortcut>> = {
  "file.save": { kind: "save" },
  "edit.clear": { kind: "delete" },
  "edit.transform": { kind: "tool", tool: "transform", cycle: false },
  // 创建/释放剪贴蒙版是同一次按键按当前图层状态决定方向（与出厂 Mod+Alt+G 一致）。
  "layer.createClippingMask": { kind: "clipping" },
  "layer.releaseClippingMask": { kind: "clipping" },
  "view.zoomIn": { kind: "view", action: "zoomIn" },
  "view.zoomOut": { kind: "view", action: "zoomOut" },
  "view.fit": { kind: "view", action: "fit" },
  "view.actualSize": { kind: "view", action: "actualSize" }
};

/** 单动作的分派形状；未知动作或不可映射的动作返回 `null`，调用方回退出厂解析。 */
export function shortcutForAction(actionId: string): EditorShortcut | null {
  const action = customizationAction(actionId);
  if (!action) return null;
  const alias = ACTION_ALIASES[actionId];
  if (alias) return alias;
  if (action.kind === "command") return { kind: "command", id: actionId };
  if (action.kind === "tool") {
    const tool = actionId.slice("tool.".length);
    if (!TOOL_IDS.has(tool)) return null;
    // 显式绑定不再按 Shift 在工具组内循环：用户绑的就是这个工具。
    return { kind: "tool", tool: tool as PhotoEditorTool, cycle: false };
  }
  const display = actionId.slice("display.".length);
  return DISPLAY_ACTIONS.includes(display as EditorDisplayAction)
    ? { kind: "display", action: display as EditorDisplayAction }
    : null;
}

/**
 * 先按本机偏好解析一次按键。
 *
 * 返回 `null` 表示「本域没有覆盖这次按键」，外壳应继续用 `resolveEditorShortcut` 出厂表；
 * 返回非空时仍须走外壳自己的只读/草稿/输入控件门禁——命中键位不等于允许写入。
 *
 * 工具组共用同一字母（魔棒/快速选择、修复/修饰）时保留出厂表的组内循环语义：显式绑定没有把
 * 一个字母拆成两个互斥动作，用户按 W 仍然是在组内切换而不是永远选同一个工具。
 */
export function preferredShortcut(
  preferences: CustomizationPreferences,
  event: ShortcutEventLike,
  isMac: boolean
): EditorShortcut | null {
  const match = matchCustomizationBinding(preferences, event, isMac);
  if (!match) return null;
  if (match.actionId.startsWith("tool.") && sharesChordWithOtherTool(preferences, match.actionId)) {
    return resolveEditorShortcut(event, isMac);
  }
  return shortcutForAction(match.actionId);
}

/**
 * 出厂分派形状 → 拥有它的可定制动作 id。
 *
 * 用于「用户改绑/解绑后，旧出厂组合必须真的失效」：偏好认领不到按键时不能一律回退出厂解析，
 * 否则把 `Mod+Z` 改成 `Mod+U` 之后 `Mod+Z` 仍会撤销（见 `resolveWithPreferences`）。
 */
function customizationActionIdsFor(shortcut: EditorShortcut): string[] {
  switch (shortcut.kind) {
    case "command":
      return [shortcut.id];
    case "save":
      return ["file.save"];
    case "tool":
      // 工具组共用同一字母（魔棒/快速选择、修复/修饰）时，两个动作都属于这次按键。
      return CUSTOMIZATION_TOOL_ACTIONS
        .filter((action) => action.id.slice("tool.".length) === shortcut.tool)
        .map((action) => action.id);
    case "display":
      return [`display.${shortcut.action}`];
    case "view":
      return [`view.${shortcut.action}`];
    case "clipping":
      return ["layer.createClippingMask", "layer.releaseClippingMask"];
    default:
      // `delete` 在出厂分派里按选区/蒙版/所选对象落到不同命令，不是一个可定制动作；
      // `transform` 走工具选中，`nudge`/`brush`/`color`/`escape`/`confirm`/`pan` 不可定制。
      return [];
  }
}

/**
 * 完整解析一次按键：偏好优先，出厂兜底，但**被用户改掉的出厂组合不再触发**。
 *
 * 外壳应当用这一个函数替换原来的 `resolveEditorShortcut(event, isMac)` 调用——一行接入，
 * 且不会出现「偏好命中不了就回退出厂、结果旧键位照旧生效」的第二种语义。
 *
 * 抑制规则：出厂解析命中的动作，若用户对它做过显式设置（改绑或解绑），且当前生效组合已不是
 * 这次按下的组合，则不认领这次按键。`Delete` 这类共享分派（清除/删除图层/删除蒙版）不参与
 * 抑制，因为它的目标由文档状态决定，不是单个可定制动作。
 */
export function resolveWithPreferences(
  preferences: CustomizationPreferences,
  event: ShortcutEventLike,
  isMac: boolean,
  fallback: (event: ShortcutEventLike, isMac: boolean) => EditorShortcut | null = resolveEditorShortcut
): EditorShortcut | null {
  const preferred = preferredShortcut(preferences, event, isMac);
  if (preferred) return preferred;
  const factory = fallback(event, isMac);
  if (!factory) return null;
  if (factory.kind === "delete") return factory;
  const actionIds = customizationActionIdsFor(factory);
  if (!actionIds.length) return factory;
  const overridden = actionIds.filter((id) => preferences.shortcuts[id] !== undefined);
  if (!overridden.length) return factory;
  // 只要还有共用的动作保留着这个组合（工具组循环、剪贴蒙版开关），就继续走出厂语义。
  const stillBound = actionIds.some((id) => chordMatchesEvent(effectiveChord(preferences, id), event, isMac));
  return stillBound ? factory : null;
}

/**
 * 组合提示：自定义绑定优先于内核自报的出厂值。
 *
 * - 有显式绑定（含显式解绑）时用偏好：解绑返回 `null`，搜索里就不显示过期提示；
 * - 没有绑定记录时用偏好里的出厂值，缺失再退回调用方给的提示。
 */
export function shortcutHint(
  preferences: CustomizationPreferences,
  actionId: string,
  isMac: boolean,
  fallback: string | null = null
): string | null {
  const label = preferredChordLabel(preferences, actionId, isMac);
  if (preferences.shortcuts[actionId] !== undefined) return label;
  return label ?? fallback;
}

/** 某个工具动作的组合是否也被另一个工具动作使用。 */
function sharesChordWithOtherTool(preferences: CustomizationPreferences, actionId: string): boolean {
  const chord = effectiveChord(preferences, actionId);
  if (!chord) return false;
  return CUSTOMIZATION_TOOL_ACTIONS.some((action) => action.id !== actionId && effectiveChord(preferences, action.id) === chord);
}

/** 菜单/工具提示用组合文本（平台换算后）；未绑定返回 `null`。 */
export function preferredChordLabel(preferences: CustomizationPreferences, actionId: string, isMac: boolean): string | null {
  const chord = effectiveChord(preferences, actionId);
  if (!chord) return null;
  const parsed = parseChord(chord);
  if (!parsed.ok || !parsed.chord) return null;
  return chordLabel(parsed.chord, isMac);
}

/** 与菜单显隐无关的结构最小面；`EditorMenuItem` 结构上满足。 */
export type MenuEntryLike = { id: string; children?: readonly MenuEntryLike[] };

/**
 * 按偏好隐藏菜单项。
 *
 * - 叶子命中即隐藏；
 * - 分组的所有子项都被隐藏时整组隐藏（不留空菜单）；
 * - 未知 id 不报错也不影响其它项。
 */
export function filterHiddenMenuItems<T extends MenuEntryLike>(items: readonly T[], hidden: readonly string[]): T[] {
  if (!hidden.length) return [...items];
  const hiddenSet = new Set(hidden);
  const walk = (nodes: readonly T[]): T[] => nodes.flatMap((node) => {
    if (node.children?.length) {
      const children = walk(node.children as readonly T[]);
      if (!children.length) return [];
      return [{ ...node, children } as T];
    }
    return hiddenSet.has(node.id) ? [] : [node];
  });
  return walk(items);
}

/**
 * 单个菜单项是否被用户隐藏。
 *
 * 注意：菜单渲染**不**走这个函数——`EditorMenuBar` 用 `filterHiddenMenuItems` 做整树过滤（因为还要
 * 处理「子项全隐藏就把整组去掉」）。这里只给需要逐项判断的调用方（例如将来做右键菜单或搜索时标注
 * 「已在菜单中隐藏」）用的便捷判断，当前生产代码没有调用点，别误以为它承担渲染职责。
 */
export function isMenuItemHidden(preferences: CustomizationPreferences, id: string): boolean {
  return preferences.menuHidden.includes(id);
}

/**
 * 工具栏完整顺序：出厂工具 ∪ 已保存顺序，**保留**隐藏项（设置界面需要列出全部工具）。
 *
 * 已保存顺序里的过期 id 被丢弃，出厂新增的工具补在末尾，因此升级后不会丢工具。
 */
export function toolbarOrderedIds(preferences: CustomizationPreferences): string[] {
  const defaults = CUSTOMIZATION_TOOL_ACTIONS.map((action) => action.id);
  const known = new Set(defaults);
  const ordered: string[] = [];
  for (const id of preferences.toolbarOrder ?? defaults) {
    if (known.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of defaults) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** 工具栏渲染顺序：完整顺序去掉隐藏项。 */
export function toolbarToolIds(preferences: CustomizationPreferences): string[] {
  const hidden = new Set(preferences.toolbarHidden);
  return toolbarOrderedIds(preferences).filter((id) => !hidden.has(id));
}

/**
 * 工具栏里共用一条按钮的工具组（`EditorToolRail` 把同组项折成一个按钮 + 呼出菜单）。
 *
 * 每组以**组首**代表渲染位置；隐藏组内非首个工具只从呼出菜单里去掉它，不能让整组消失
 * （否则隐藏「快速选择」会把「魔棒」也一起藏掉）。
 */
export const TOOLBAR_GROUPS = TOOL_GROUPS as readonly (readonly PhotoEditorTool[])[];

/**
 * 工具栏实际渲染的组（按偏好顺序，仅含仍可见的工具）。
 *
 * 返回 `{ tool, group }`：`tool` 是组内当前代表（组首仍在时用组首），`group` 是组内仍可见的成员。
 * 整组都隐藏时该组不出现。
 */
export function toolbarRenderGroups(preferences: CustomizationPreferences): { tool: PhotoEditorTool; group: PhotoEditorTool[] }[] {
  const visible = new Set(toolbarToolIds(preferences).map((id) => id.slice("tool.".length)));
  const emitted = new Set<string>();
  const out: { tool: PhotoEditorTool; group: PhotoEditorTool[] }[] = [];
  for (const id of toolbarToolIds(preferences)) {
    const tool = id.slice("tool.".length) as PhotoEditorTool;
    if (emitted.has(tool)) continue;
    const shared = TOOLBAR_GROUPS.find((group) => group.includes(tool));
    if (!shared) {
      emitted.add(tool);
      out.push({ tool, group: [tool] });
      continue;
    }
    // 组只发射一次：以偏好顺序里最先出现的可见成员为锚点（React key / 按钮身份稳定跟随用户顺序），
    // 呼出菜单里的成员仍按出厂组顺序排列。
    const members = shared.filter((member) => visible.has(member));
    for (const member of shared) emitted.add(member);
    if (!members.length) continue;
    out.push({ tool, group: members });
  }
  return out;
}

/**
 * 工作区里的面板几何 → 布局所有者可用的规范化布局。
 *
 * 只补/校验已知字段并保留当前会话中未被工作区覆盖的取值；无几何或几何非法时返回 `null`，
 * 调用方保持现有布局而不是重置成出厂值。
 */
export function workspacePanelLayout(
  layout: Record<string, unknown> | null | undefined,
  current: EditorPanelLayout
): EditorPanelLayout | null {
  if (!layout || !Object.keys(layout).length) return null;
  try {
    return normalizePanelLayout({ ...current, ...layout });
  } catch {
    return null;
  }
}

/** 画笔类工具可记忆的数值字段（工具状态，不进文档内容）。 */
const BRUSH_FIELDS = ["size", "hardness", "opacity", "flow", "smoothing"] as const;

export type BrushLike = Partial<Record<(typeof BRUSH_FIELDS)[number], number>>;

/** 从画笔设置里挑出可记忆的有界数值；非有限数被忽略。 */
export function brushOptionValues(brush: BrushLike): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of BRUSH_FIELDS) {
    const value = brush[key];
    if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
  }
  return values;
}

/**
 * 恢复某工具最近一次选项：只覆盖本次传入的字段，未记忆的字段保持调用方的当前值。
 * 未记忆或全部字段非法时返回 `null`（不要用空对象覆盖）。
 */
export function storedToolOptions(
  preferences: CustomizationPreferences,
  tool: string
): Record<string, number | string | boolean> | null {
  const stored = preferences.toolOptions[tool];
  if (!stored || !Object.keys(stored).length) return null;
  return { ...stored };
}

/** 把已记忆的画笔选项并回当前设置（只取数值字段）。 */
export function restoreBrushOptions<T extends BrushLike>(preferences: CustomizationPreferences, tool: string, brush: T): T {
  const stored = storedToolOptions(preferences, tool);
  if (!stored) return brush;
  const next = { ...brush };
  for (const key of BRUSH_FIELDS) {
    const value = stored[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  }
  return next;
}
