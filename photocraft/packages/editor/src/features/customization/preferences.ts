import { TOOL_GROUPS } from "../tool-groups.js";
import { VECTOR_TOOLS } from "../vectors/vector-tools.js";
import { PAINTING_TOOL_WIRING } from "../painting/tool-manifest.js";
/**
 * 命令搜索与工作区定制的本机偏好（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D2/D3）。
 *
 * 这里是**唯一**的偏好模型：快捷键覆盖、工具栏隐藏/顺序、菜单隐藏、工具选项记忆与命名工作区。
 * 约束：
 * - 偏好只保存动作/工具 id、布局参数和版本号，动作语义仍属于各功能模块；
 * - 偏好不进入工程字节、内容身份、历史或撤销栈，写失败时不伪造「已保存」；
 * - 未知动作 id、非法快捷键、超预算条目在解码时丢弃并给出告警，而不是让整份偏好失效；
 * - 冲突必须先解决（覆盖或取消），覆盖只解除同一组合上的其他绑定。
 *
 * 本模块不接触 DOM 与 React，可在纯 node 环境测试。
 */
import {
  COMMAND_SHORTCUTS,
  DISPLAY_SHORTCUTS,
  FILL_SHORTCUTS,
  TOOL_KEYS,
  shortcutLabel
} from "../../photo-editor-shortcuts.js";

/** 偏好结构版本；与存储键一起决定兼容性。 */
export const CUSTOMIZATION_VERSION = 1 as const;
/** 本机存储键；版本化，旧版本按「版本失配」拒绝而不是猜测迁移。 */
export const CUSTOMIZATION_STORAGE_KEY = "woohaa.image-editor.customization.v1";
/** 命令搜索记忆的最近命令条数（会话内，不持久化）。 */
export const RECENT_COMMANDS_CAP = 8;

/** 有界预算：超出预算的操作被拒绝，读取时超限条目被丢弃。 */
export const CUSTOMIZATION_LIMITS = {
  shortcuts: 256,
  ids: 128,
  workspaces: 8,
  workspaceName: 40,
  toolOptions: 24,
  toolOptionFields: 24,
  toolOptionString: 80,
  layoutKeys: 24,
  layoutJson: 2048
} as const;

// ---------------------------------------------------------------- 组合键

export type Chord = { key: string; mod: boolean; alt: boolean; shift: boolean };
export type ChordParse = { ok: true; chord: Chord | null } | { ok: false; reason: string };
export type EventChordParse = { ok: true; chord: string } | { ok: false; reason: string };

const MODIFIER_TOKENS = new Set(["mod", "ctrl", "cmd", "command", "meta"]);
const ALT_TOKENS = new Set(["alt", "option", "opt"]);
const NAMED_KEY_BY_TOKEN: Record<string, string> = {
  tab: "Tab", escape: "Escape", esc: "Escape", enter: "Enter", return: "Enter",
  space: "Space", backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight"
};
const SYMBOL_KEYS = "`-=[]\\;',./";
const FUNCTION_KEY = /^f(?:[1-9]|1[0-9]|2[0-4])$/;

/** 浏览器通常占用的组合；可以保存，但提示「可能被浏览器拦截」，不承诺拦截。 */
const BROWSER_RESERVED = new Set(["Mod+W", "Mod+T", "Mod+N", "Mod+Shift+T", "Mod+Q", "Mod+Shift+W"]);

function normalizeKeyToken(token: string): string | null {
  const lower = token.trim().toLowerCase();
  if (!lower) return null;
  if (FUNCTION_KEY.test(lower)) return lower.toUpperCase();
  const named = NAMED_KEY_BY_TOKEN[lower];
  if (named) return named;
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  if (lower.length === 1 && SYMBOL_KEYS.includes(lower)) return lower;
  if (lower === "+") return "+";
  return null;
}

/** 解析规范组合文本（`Mod+Shift+Z`、`Alt+Backspace`、`B`、`Tab`）；空串表示未绑定。 */
export function parseChord(text: string): ChordParse {
  const raw = text.trim();
  if (!raw) return { ok: true, chord: null };
  const tokens: string[] = raw.endsWith("++")
    ? [...raw.slice(0, -2).split("+").map((token) => token.trim()).filter(Boolean), "+"]
    : raw.split("+").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, reason: "缺少按键" };
  if (tokens.length > 4) return { ok: false, reason: "修饰键过长" };
  let mod = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (MODIFIER_TOKENS.has(lower)) {
      if (key !== null) return { ok: false, reason: "修饰键必须在主键之前" };
      if (mod) return { ok: false, reason: "修饰键重复" };
      mod = true;
      continue;
    }
    if (ALT_TOKENS.has(lower)) {
      if (key !== null) return { ok: false, reason: "修饰键必须在主键之前" };
      if (alt) return { ok: false, reason: "修饰键重复" };
      alt = true;
      continue;
    }
    if (lower === "shift") {
      if (key !== null) return { ok: false, reason: "修饰键必须在主键之前" };
      if (shift) return { ok: false, reason: "修饰键重复" };
      shift = true;
      continue;
    }
    if (key !== null) return { ok: false, reason: "只能绑定一个主键" };
    const normalized = normalizeKeyToken(token);
    if (!normalized) return { ok: false, reason: `无法识别的按键「${token}」` };
    key = normalized;
  }
  if (key === null) return { ok: false, reason: "缺少主键" };
  return { ok: true, chord: { key, mod, alt, shift } };
}

/** 规范化文本：`Mod`、`Alt`、`Shift` 固定顺序，主键大写。 */
export function formatChord(chord: Chord): string {
  return [chord.mod ? "Mod" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : "", chord.key]
    .filter(Boolean)
    .join("+");
}

/** 展示用标签（macOS 显示 ⌘/Option）；沿用既有清单的同一换算。 */
export function chordLabel(chord: Chord, isMac = false): string {
  return shortcutLabel(formatChord(chord), isMac);
}

export function isBrowserReserved(chord: Chord): boolean {
  return BROWSER_RESERVED.has(formatChord(chord));
}

export type ShortcutEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode"
>;

const NAMED_KEY_BY_EVENT: Record<string, string> = {
  tab: "Tab", escape: "Escape", enter: "Enter", " ": "Space", backspace: "Backspace",
  delete: "Delete", insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight"
};

function eventKey(event: ShortcutEventLike): string | null {
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  const key = event.key;
  if (!key) return null;
  const named = NAMED_KEY_BY_EVENT[key.toLowerCase()];
  if (named) return named;
  if (FUNCTION_KEY.test(key.toLowerCase())) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return null;
}

/** 把一次按键转成规范组合文本；纯修饰键或输入法合成中返回失败。 */
export function chordFromEvent(event: ShortcutEventLike, isMac: boolean): EventChordParse {
  if (event.isComposing || event.keyCode === 229) return { ok: false, reason: "输入法合成中不绑定快捷键" };
  const key = eventKey(event);
  if (!key) return { ok: false, reason: "请按下包含主键的组合" };
  const named = NAMED_KEY_BY_EVENT[event.key.toLowerCase()];
  if (!named && !FUNCTION_KEY.test(event.key.toLowerCase()) && event.key.length > 1) {
    return { ok: false, reason: "请按下包含主键的组合" };
  }
  if (isMac && event.ctrlKey) return { ok: false, reason: "macOS 上请使用 ⌘ 作为主修饰键" };
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return { ok: true, chord: formatChord({ key, mod, alt: event.altKey, shift: event.shiftKey }) };
}

// ---------------------------------------------------------------- 动作清单

export type CustomizationActionKind = "command" | "tool" | "display";
export type CustomizationAction = {
  /** 稳定动作 id（命令 id、`tool.<id>`、`display.<action>`）。 */
  id: string;
  label: string;
  kind: CustomizationActionKind;
  /** 默认组合（规范文本）；出厂清单只来自已接通的表。 */
  defaultChord: string;
};

const TOOL_ACTIONS: Partial<Record<string, string>> = {
  move: "移动",
  marquee: "矩形 / 椭圆选框",
  lasso: "套索", "polygon-lasso": "多边形套索", "magnetic-lasso": "磁性套索", crop: "裁剪", hand: "抓手", zoom: "缩放",
  wand: "魔棒",
  quick: "快速选择",
  brush: "画笔",
  eraser: "橡皮擦",
  text: "文字",
  clone: "仿制图章",
  heal: "污点修复",
  retouch: "修饰",
  pen: "钢笔"
};

const COMMAND_LABELS: Record<string, string> = {
  "edit.copy": "复制",
  "edit.copyMerged": "合并复制",
  "edit.cut": "剪切",
  "edit.paste": "粘贴",
  "edit.pasteSpecial.pasteInPlace": "原位粘贴",
  "edit.undo": "撤销",
  "edit.redo": "重做",
  "select.all": "全部",
  "select.deselect": "取消选择",
  "select.reselect": "重新选择",
  "select.inverse": "反向",
  "layer.new.layer": "新建图层",
  "layer.groupLayers": "图层编组",
  "layer.ungroupLayers": "取消图层编组",
  "layer.new.layerViaCopy": "通过拷贝的图层",
  "layer.mergeLayers": "合并图层",
  "layer.mergeVisible": "合并可见图层",
  "layer.arrange.bringForward": "前移一层",
  "layer.arrange.sendBackward": "后移一层",
  "layer.arrange.bringToFront": "置为顶层",
  "layer.arrange.sendToBack": "置为底层"
};

const FILL_LABELS: Record<string, string> = {
  "edit.fillForeground": "填充前景色",
  "edit.fillBackground": "填充背景色",
  "edit.fillForegroundPreserve": "填充前景色（保留透明度）",
  "edit.fillBackgroundPreserve": "填充背景色（保留透明度）"
};

const DISPLAY_LABELS: Record<string, string> = {
  extras: "额外内容（选区与变换边界）",
  panels: "工具与面板",
  sidebar: "侧栏面板"
};

/** 不在既有声明表里、但菜单/状态条已经公布的固定组合。 */
const EXTRA_ACTIONS: readonly { id: string; label: string; chord: string }[] = [
  { id: "edit.transform", label: "自由变换", chord: "Mod+T" },
  { id: "layer.createClippingMask", label: "创建剪贴蒙版", chord: "Mod+Alt+G" },
  { id: "layer.releaseClippingMask", label: "释放剪贴蒙版", chord: "Mod+Alt+G" },
  { id: "edit.clear", label: "清除", chord: "Delete" },
  { id: "file.save", label: "保存", chord: "Mod+S" },
  { id: "view.zoomIn", label: "放大", chord: "Mod+=" },
  { id: "view.zoomOut", label: "缩小", chord: "Mod+-" },
  { id: "view.fit", label: "适合窗口", chord: "Mod+0" },
  { id: "view.actualSize", label: "实际大小", chord: "Mod+1" }
];

/**
 * 允许共用同一组合的动作组：工具组按同一字母循环，剪贴蒙版创建/释放是同一开关。
 * 组内共用不算冲突；其他重复必须先解决。
 */
const SHARED_CHORD_GROUPS: readonly (readonly string[])[] = [
  ...TOOL_GROUPS.map(group => group.map(tool => `tool.${tool}`)),
  ["layer.createClippingMask", "layer.releaseClippingMask"]
];

function commandChord(key: string, shift: boolean, alt = false): string {
  return formatChord({ key: key.length === 1 ? key.toUpperCase() : key, mod: true, alt, shift });
}

function buildActions(): CustomizationAction[] {
  const actions: CustomizationAction[] = [];
  const seen = new Set<string>();
  const push = (action: CustomizationAction) => {
    if (seen.has(action.id)) return;
    seen.add(action.id);
    actions.push(action);
  };
  for (const entry of COMMAND_SHORTCUTS) {
    push({ id: entry.id, label: COMMAND_LABELS[entry.id] ?? entry.id, kind: "command", defaultChord: commandChord(entry.key, entry.shift, entry.alt) });
  }
  for (const entry of EXTRA_ACTIONS) {
    push({ id: entry.id, label: entry.label, kind: "command", defaultChord: entry.chord });
  }
  for (const entry of FILL_SHORTCUTS) {
    push({
      id: entry.id,
      label: FILL_LABELS[entry.id] ?? entry.id,
      kind: "command",
      defaultChord: formatChord({ key: "Backspace", mod: entry.mod, alt: entry.alt, shift: entry.shift })
    });
  }
  for (const entry of DISPLAY_SHORTCUTS) {
    push({
      id: `display.${entry.action}`,
      label: DISPLAY_LABELS[entry.action] ?? entry.action,
      kind: "display",
      defaultChord: formatChord({ key: normalizeKeyToken(entry.key) ?? entry.key, mod: entry.mod, alt: false, shift: entry.shift })
    });
  }
  for (const [tool, letter] of Object.entries(TOOL_KEYS)) {
    if (letter) push({ id: `tool.${tool}`, label: TOOL_ACTIONS[tool] ?? tool, kind: "tool", defaultChord: letter.toUpperCase() });
  }
  for (const tool of [...PAINTING_TOOL_WIRING, ...VECTOR_TOOLS]) {
    push({ id: `tool.${tool.id}`, label: tool.label, kind: "tool", defaultChord: TOOL_KEYS[tool.id as keyof typeof TOOL_KEYS] ?? "" });
  }
  return actions;
}

/** 出厂动作清单（顺序稳定；同一字母的工具组相邻）。 */
export const CUSTOMIZATION_ACTIONS: readonly CustomizationAction[] = buildActions();
const ACTIONS_BY_ID = new Map(CUSTOMIZATION_ACTIONS.map((action) => [action.id, action]));

/** 工具栏可定制的工具动作（顺序即出厂工具栏顺序）。 */
const TOOLBAR_ORDER = ["move", "marquee", "lasso", "polygon-lasso", "magnetic-lasso", "wand", "quick", "crop", "brush", "pencil", "colorReplacement", "eraser", "backgroundEraser", "magicEraser", "gradient", "bucket", "eyedropper", "text", "clone", "heal", "retouch", "pen", ...VECTOR_TOOLS.map(tool => tool.id), "hand", "zoom"];
export const CUSTOMIZATION_TOOL_ACTIONS: readonly CustomizationAction[] = CUSTOMIZATION_ACTIONS.filter((action) => action.kind === "tool")
  .sort((a, b) => TOOLBAR_ORDER.indexOf(a.id.slice(5)) - TOOLBAR_ORDER.indexOf(b.id.slice(5)));

export function customizationAction(id: string): CustomizationAction | undefined {
  return ACTIONS_BY_ID.get(id);
}

export function actionLabel(id: string): string {
  return ACTIONS_BY_ID.get(id)?.label ?? id;
}

/** 按类别取动作清单（快捷键界面分组用）。 */
export function customizationActionsByKind(kind: CustomizationActionKind): readonly CustomizationAction[] {
  return CUSTOMIZATION_ACTIONS.filter((action) => action.kind === kind);
}

function sharedGroupOf(ids: readonly string[]): string | null {
  for (const group of SHARED_CHORD_GROUPS) {
    if (ids.every((id) => group.includes(id))) return group.join("|");
  }
  return null;
}

// ---------------------------------------------------------------- 偏好数据

export type ToolOptionValue = string | number | boolean;
export type ToolOptions = Record<string, ToolOptionValue>;

export type WorkspacePreset = {
  id: string;
  name: string;
  shortcuts: Record<string, string>;
  toolbarHidden: string[];
  toolbarOrder: string[] | null;
  menuHidden: string[];
  /** 面板几何快照；由布局所有者校验后应用，本模块只保存有界数据。 */
  panelLayout: Record<string, unknown> | null;
  createdAt: number;
};

export type CustomizationPreferences = {
  version: typeof CUSTOMIZATION_VERSION;
  /** 动作 id → 规范组合；空串表示用户显式解绑。缺省表示出厂默认。 */
  shortcuts: Record<string, string>;
  toolbarHidden: string[];
  toolbarOrder: string[] | null;
  menuHidden: string[];
  toolOptions: Record<string, ToolOptions>;
  workspaces: WorkspacePreset[];
  activeWorkspace: string | null;
};

export function defaultPreferences(): CustomizationPreferences {
  return {
    version: CUSTOMIZATION_VERSION,
    shortcuts: {},
    toolbarHidden: [],
    toolbarOrder: null,
    menuHidden: [],
    toolOptions: {},
    workspaces: [],
    activeWorkspace: null
  };
}

export function effectiveChord(preferences: CustomizationPreferences, actionId: string): string {
  const override = preferences.shortcuts[actionId];
  if (override !== undefined) return override;
  return customizationAction(actionId)?.defaultChord ?? "";
}

export type ChordConflict = { chord: string; actionIds: string[]; labels: string[] };

/** 当前生效绑定里的冲突（组内共用不算）。 */
export function chordConflicts(preferences: CustomizationPreferences): ChordConflict[] {
  const byChord = new Map<string, string[]>();
  for (const action of CUSTOMIZATION_ACTIONS) {
    const chord = effectiveChord(preferences, action.id);
    if (!chord) continue;
    byChord.set(chord, [...(byChord.get(chord) ?? []), action.id]);
  }
  const conflicts: ChordConflict[] = [];
  for (const [chord, ids] of byChord) {
    if (ids.length < 2 || sharedGroupOf(ids)) continue;
    conflicts.push({ chord, actionIds: ids, labels: ids.map(actionLabel) });
  }
  return conflicts.sort((a, b) => a.chord.localeCompare(b.chord));
}

/** 只报告与某个动作相关的冲突（设置新组合时使用）。 */
export function conflictsFor(preferences: CustomizationPreferences, actionId: string): ChordConflict[] {
  return chordConflicts(preferences).filter((conflict) => conflict.actionIds.includes(actionId));
}

// ---------------------------------------------------------------- 校验/解码

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) return null;
  return text;
}

function decodeShortcutMap(value: unknown, warnings: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    warnings.push("快捷键表结构非法，已忽略");
    return {};
  }
  const shortcuts: Record<string, string> = {};
  let count = 0;
  for (const [id, raw] of Object.entries(value)) {
    if (count >= CUSTOMIZATION_LIMITS.shortcuts) {
      warnings.push("快捷键条目超过上限，多余项已忽略");
      break;
    }
    if (!customizationAction(id)) {
      warnings.push(`未知动作「${id}」的快捷键已忽略`);
      continue;
    }
    if (typeof raw !== "string") {
      warnings.push(`动作「${id}」的快捷键不是文本，已忽略`);
      continue;
    }
    const parsed = parseChord(raw);
    if (!parsed.ok) {
      warnings.push(`动作「${id}」的快捷键「${raw}」无效：${parsed.reason}`);
      continue;
    }
    shortcuts[id] = parsed.chord ? formatChord(parsed.chord) : "";
    count += 1;
  }
  return shortcuts;
}

function decodeIdList(value: unknown, warnings: string[], label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label}结构非法，已忽略`);
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (ids.length >= CUSTOMIZATION_LIMITS.ids) {
      warnings.push(`${label}超过上限，多余项已忽略`);
      break;
    }
    if (!boundedId(entry)) {
      warnings.push(`${label}包含非法条目，已忽略`);
      continue;
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

function decodeToolOptions(value: unknown, warnings: string[]): Record<string, ToolOptions> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    warnings.push("工具选项记忆结构非法，已忽略");
    return {};
  }
  const out: Record<string, ToolOptions> = {};
  let tools = 0;
  for (const [tool, raw] of Object.entries(value)) {
    if (tools >= CUSTOMIZATION_LIMITS.toolOptions) {
      warnings.push("工具选项记忆超过上限，多余项已忽略");
      break;
    }
    if (!boundedId(tool) || !isRecord(raw)) {
      warnings.push(`工具「${tool}」的选项记忆已忽略`);
      continue;
    }
    const options: ToolOptions = {};
    let fields = 0;
    for (const [key, option] of Object.entries(raw)) {
      if (fields >= CUSTOMIZATION_LIMITS.toolOptionFields) {
        warnings.push(`工具「${tool}」的选项超过上限，多余项已忽略`);
        break;
      }
      if (!boundedId(key)) {
        warnings.push(`工具「${tool}」的选项名非法，已忽略`);
        continue;
      }
      if (typeof option === "boolean") options[key] = option;
      else if (typeof option === "number" && Number.isFinite(option)) options[key] = option;
      else if (typeof option === "string" && option.length <= CUSTOMIZATION_LIMITS.toolOptionString && !/[\u0000-\u001f]/.test(option)) options[key] = option;
      else {
        warnings.push(`工具「${tool}」的选项「${key}」值非法，已忽略`);
        continue;
      }
      fields += 1;
    }
    if (!fields) continue;
    out[tool] = options;
    tools += 1;
  }
  return out;
}

function boundedLayout(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Object.keys(value).length > CUSTOMIZATION_LIMITS.layoutKeys) return null;
  try {
    if (JSON.stringify(value).length > CUSTOMIZATION_LIMITS.layoutJson) return null;
  } catch {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!boundedId(key)) return null;
    if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) out[key] = entry;
    else if (typeof entry === "string" && entry.length <= CUSTOMIZATION_LIMITS.toolOptionString) out[key] = entry;
    else if (Array.isArray(entry) && entry.length <= 8 && entry.every((item) => typeof item === "number" && Number.isFinite(item))) out[key] = [...entry];
    else if (isRecord(entry)) {
      const points: Record<string, { x: number; y: number }> = {};
      for (const [id, point] of Object.entries(entry)) {
        if (!boundedId(id) || !isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        points[id] = { x: point.x as number, y: point.y as number };
      }
      out[key] = points;
    } else return null;
  }
  return out;
}

function decodeWorkspaces(value: unknown, warnings: string[]): WorkspacePreset[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push("工作区列表结构非法，已忽略");
    return [];
  }
  const presets: WorkspacePreset[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (presets.length >= CUSTOMIZATION_LIMITS.workspaces) {
      warnings.push("工作区数量超过上限，多余项已忽略");
      break;
    }
    if (!isRecord(raw) || !boundedId(raw.id) || ids.has(raw.id)) {
      warnings.push("工作区条目非法，已忽略");
      continue;
    }
    const name = boundedText(raw.name, CUSTOMIZATION_LIMITS.workspaceName);
    if (!name) {
      warnings.push("工作区名称非法，已忽略");
      continue;
    }
    ids.add(raw.id);
    const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
    presets.push({
      id: raw.id,
      name,
      shortcuts: decodeShortcutMap(raw.shortcuts, warnings),
      toolbarHidden: decodeIdList(raw.toolbarHidden, warnings, "工作区工具栏隐藏"),
      toolbarOrder: Array.isArray(raw.toolbarOrder) ? decodeIdList(raw.toolbarOrder, warnings, "工作区工具栏顺序") : null,
      menuHidden: decodeIdList(raw.menuHidden, warnings, "工作区菜单隐藏"),
      panelLayout: boundedLayout(raw.panelLayout),
      createdAt
    });
  }
  return presets;
}

export type DecodePreferences =
  | { ok: true; preferences: CustomizationPreferences; warnings: string[] }
  | { ok: false; code: "version" | "invalid"; reason: string };

/** 严格解码：版本失配或结构非法时整体拒绝，不猜测迁移。 */
export function decodePreferences(raw: unknown): DecodePreferences {
  if (!isRecord(raw)) return { ok: false, code: "invalid", reason: "偏好数据不是对象" };
  if (raw.version !== CUSTOMIZATION_VERSION) {
    return { ok: false, code: "version", reason: `偏好版本不匹配（期望 ${CUSTOMIZATION_VERSION}，实际 ${String(raw.version)}）` };
  }
  const warnings: string[] = [];
  const workspaces = decodeWorkspaces(raw.workspaces, warnings);
  const activeWorkspace = typeof raw.activeWorkspace === "string" && workspaces.some((preset) => preset.id === raw.activeWorkspace)
    ? raw.activeWorkspace
    : null;
  return {
    ok: true,
    warnings,
    preferences: {
      version: CUSTOMIZATION_VERSION,
      shortcuts: decodeShortcutMap(raw.shortcuts, warnings),
      toolbarHidden: decodeIdList(raw.toolbarHidden, warnings, "工具栏隐藏"),
      toolbarOrder: Array.isArray(raw.toolbarOrder) ? decodeIdList(raw.toolbarOrder, warnings, "工具栏顺序") : null,
      menuHidden: decodeIdList(raw.menuHidden, warnings, "菜单隐藏"),
      toolOptions: decodeToolOptions(raw.toolOptions, warnings),
      workspaces,
      activeWorkspace
    }
  };
}

// ---------------------------------------------------------------- 持久化

export type PreferenceStorage = {
  read(key: string): string | null;
  write(key: string, value: string): void;
};

/** 浏览器本机存储；受限/无权限时返回 null（偏好只在会话内保留，界面明确提示）。 */
export function browserPreferenceStorage(): PreferenceStorage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${CUSTOMIZATION_STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return { read: (key) => storage.getItem(key), write: (key, value) => storage.setItem(key, value) };
  } catch {
    return null;
  }
}

export type CustomizationPersistence = "local" | "memory";
export type CustomizationState = {
  preferences: CustomizationPreferences;
  persistence: CustomizationPersistence;
  /** 读取失败/降级原因；成功保存后清空。 */
  loadError: string | null;
};

export type CustomizationFailureCode = "invalid" | "conflict" | "limit" | "storage" | "missing";
export type CustomizationResult =
  /** `warnings` 只在「成功但有条目被丢弃」时出现（例如导入含未知动作的偏好文件）。 */
  | { ok: true; warnings?: string[] }
  | { ok: false; code: CustomizationFailureCode; message: string; conflicts?: ChordConflict[] };
export type WorkspaceApplyResult =
  | { ok: true; panelLayout: Record<string, unknown> | null }
  | { ok: false; code: CustomizationFailureCode; message: string };

function samePreferences(a: CustomizationPreferences, b: CustomizationPreferences): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 工作区快照覆盖的三组设置是否仍与当前设置一致。 */
function matchesWorkspace(preferences: CustomizationPreferences, preset: WorkspacePreset): boolean {
  return JSON.stringify({
    shortcuts: preferences.shortcuts,
    toolbarHidden: preferences.toolbarHidden,
    toolbarOrder: preferences.toolbarOrder,
    menuHidden: preferences.menuHidden
  }) === JSON.stringify({
    shortcuts: preset.shortcuts,
    toolbarHidden: preset.toolbarHidden,
    toolbarOrder: preset.toolbarOrder,
    menuHidden: preset.menuHidden
  });
}

/**
 * 偏好仓库：读-改-写全部经过 `commit`。
 *
 * `commit` **先写存储再发布内存状态**：写入失败时操作整体取消并保留原设置，不产生「看起来已保存」
 * 的假象。读取失败时保留内存默认值，并在界面提示旧数据仍原样留在存储里。
 */
export class CustomizationStore {
  private state: CustomizationState;
  private readonly listeners = new Set<() => void>();
  private workspaceSequence = 0;

  constructor(private readonly storage: PreferenceStorage | null = browserPreferenceStorage()) {
    this.state = this.restore();
  }

  snapshot = (): CustomizationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private restore(): CustomizationState {
    if (!this.storage) {
      return {
        preferences: defaultPreferences(),
        persistence: "memory",
        loadError: "当前环境不允许本机存储，本次修改只在当前会话内保留"
      };
    }
    let text: string | null;
    try {
      text = this.storage.read(CUSTOMIZATION_STORAGE_KEY);
    } catch {
      return { preferences: defaultPreferences(), persistence: "local", loadError: "无法读取本机偏好存储，已使用默认值" };
    }
    if (!text) return { preferences: defaultPreferences(), persistence: "local", loadError: null };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { preferences: defaultPreferences(), persistence: "local", loadError: "本机偏好不是有效 JSON，已使用默认值；保存任意设置会覆盖它" };
    }
    const decoded = decodePreferences(raw);
    if (!decoded.ok) {
      return {
        preferences: defaultPreferences(),
        persistence: "local",
        loadError: `${decoded.reason}，已使用默认值；保存任意设置会覆盖它`
      };
    }
    return {
      preferences: decoded.preferences,
      persistence: "local",
      loadError: decoded.warnings.length ? decoded.warnings.join("；") : null
    };
  }

  private commit(next: CustomizationPreferences): CustomizationResult {
    const preferences: CustomizationPreferences = { ...next, version: CUSTOMIZATION_VERSION };
    if (samePreferences(preferences, this.state.preferences) && !this.state.loadError) return { ok: true };
    // 应用工作区后再改任何设置，就等于离开了那个工作区：不能继续标着「当前工作区」却已不是它。
    if (preferences.activeWorkspace) {
      const preset = preferences.workspaces.find((entry) => entry.id === preferences.activeWorkspace);
      if (!preset || !matchesWorkspace(preferences, preset)) preferences.activeWorkspace = null;
    }
    if (this.storage) {
      try {
        this.storage.write(CUSTOMIZATION_STORAGE_KEY, JSON.stringify(preferences));
      } catch {
        return { ok: false, code: "storage", message: "无法写入本机偏好存储，已保留原设置" };
      }
    }
    this.state = { ...this.state, preferences, loadError: null };
    for (const listener of this.listeners) listener();
    return { ok: true };
  }

  /** 设置快捷键；冲突时返回候选并要求覆盖或取消。 */
  setShortcut(actionId: string, text: string, options: { force?: boolean } = {}): CustomizationResult {
    const action = customizationAction(actionId);
    if (!action) return { ok: false, code: "invalid", message: `未知的可定制动作：${actionId}` };
    const parsed = parseChord(text);
    if (!parsed.ok) return { ok: false, code: "invalid", message: `快捷键无效：${parsed.reason}` };
    const chord = parsed.chord ? formatChord(parsed.chord) : "";
    const shortcuts: Record<string, string> = { ...this.state.preferences.shortcuts, [actionId]: chord };
    if (parsed.chord) {
      const conflicts = conflictsFor({ ...this.state.preferences, shortcuts }, actionId);
      if (conflicts.length) {
        const others = [...new Set(conflicts.flatMap((conflict) => conflict.actionIds).filter((id) => id !== actionId))];
        if (!options.force) {
          return {
            ok: false,
            code: "conflict",
            message: `${chordLabel(parsed.chord)} 已被「${others.map(actionLabel).join("、")}」使用，请覆盖或取消`,
            conflicts
          };
        }
        for (const id of others) shortcuts[id] = "";
      }
    }
    return this.commit({ ...this.state.preferences, shortcuts });
  }

  /** 恢复该动作的出厂组合（删除覆盖）。 */
  resetShortcut(actionId: string): CustomizationResult {
    if (!customizationAction(actionId)) return { ok: false, code: "invalid", message: `未知的可定制动作：${actionId}` };
    if (this.state.preferences.shortcuts[actionId] === undefined) return { ok: true };
    const shortcuts = { ...this.state.preferences.shortcuts };
    delete shortcuts[actionId];
    return this.commit({ ...this.state.preferences, shortcuts });
  }

  resetShortcuts(): CustomizationResult {
    return this.commit({ ...this.state.preferences, shortcuts: {} });
  }

  setToolbarHidden(ids: readonly string[]): CustomizationResult {
    const list: string[] = [];
    for (const id of ids) {
      if (!boundedId(id)) return { ok: false, code: "invalid", message: `工具栏条目非法：${String(id)}` };
      if (list.length >= CUSTOMIZATION_LIMITS.ids) return { ok: false, code: "limit", message: `工具栏条目最多 ${CUSTOMIZATION_LIMITS.ids} 个` };
      if (!list.includes(id)) list.push(id);
    }
    return this.commit({ ...this.state.preferences, toolbarHidden: list });
  }

  setToolbarOrder(order: readonly string[] | null): CustomizationResult {
    if (order === null) return this.commit({ ...this.state.preferences, toolbarOrder: null });
    const list: string[] = [];
    for (const id of order) {
      if (!boundedId(id)) return { ok: false, code: "invalid", message: `工具栏顺序条目非法：${String(id)}` };
      if (list.length >= CUSTOMIZATION_LIMITS.ids) return { ok: false, code: "limit", message: `工具栏顺序最多 ${CUSTOMIZATION_LIMITS.ids} 项` };
      if (!list.includes(id)) list.push(id);
    }
    return this.commit({ ...this.state.preferences, toolbarOrder: list });
  }

  resetToolbar(): CustomizationResult {
    return this.commit({ ...this.state.preferences, toolbarHidden: [], toolbarOrder: null });
  }

  setMenuHidden(ids: readonly string[]): CustomizationResult {
    const list: string[] = [];
    for (const id of ids) {
      if (!boundedId(id)) return { ok: false, code: "invalid", message: `菜单条目非法：${String(id)}` };
      if (list.length >= CUSTOMIZATION_LIMITS.ids) return { ok: false, code: "limit", message: `菜单条目最多 ${CUSTOMIZATION_LIMITS.ids} 个` };
      if (!list.includes(id)) list.push(id);
    }
    return this.commit({ ...this.state.preferences, menuHidden: list });
  }

  resetMenus(): CustomizationResult {
    return this.commit({ ...this.state.preferences, menuHidden: [] });
  }

  /** 记录工具面板最近使用的选项（工具状态，不进入文档内容）。 */
  rememberToolOptions(tool: string, values: Record<string, unknown>): CustomizationResult {
    if (!boundedId(tool)) return { ok: false, code: "invalid", message: "工具 id 非法" };
    const options: ToolOptions = {};
    let fields = 0;
    for (const [key, value] of Object.entries(values)) {
      if (!boundedId(key)) return { ok: false, code: "invalid", message: `工具选项名非法：${key}` };
      if (fields >= CUSTOMIZATION_LIMITS.toolOptionFields) {
        return { ok: false, code: "limit", message: `工具选项最多 ${CUSTOMIZATION_LIMITS.toolOptionFields} 项` };
      }
      if (typeof value === "boolean") options[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) options[key] = value;
      else if (typeof value === "string" && value.length <= CUSTOMIZATION_LIMITS.toolOptionString && !/[\u0000-\u001f]/.test(value)) options[key] = value;
      else return { ok: false, code: "invalid", message: `工具选项「${key}」的值非法` };
      fields += 1;
    }
    const toolOptions = { ...this.state.preferences.toolOptions };
    if (!fields) delete toolOptions[tool];
    else toolOptions[tool] = options;
    if (Object.keys(toolOptions).length > CUSTOMIZATION_LIMITS.toolOptions) {
      return { ok: false, code: "limit", message: `工具选项记忆最多 ${CUSTOMIZATION_LIMITS.toolOptions} 个工具` };
    }
    return this.commit({ ...this.state.preferences, toolOptions });
  }

  clearToolOptions(tool?: string): CustomizationResult {
    if (tool === undefined) return this.commit({ ...this.state.preferences, toolOptions: {} });
    const toolOptions = { ...this.state.preferences.toolOptions };
    delete toolOptions[tool];
    return this.commit({ ...this.state.preferences, toolOptions });
  }

  /** 把当前快捷键/工具栏/菜单与传入的面板几何保存为命名工作区。 */
  saveWorkspace(name: string, options: { panelLayout?: Record<string, unknown> | null } = {}): CustomizationResult {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, code: "invalid", message: "请输入工作区名称" };
    if (trimmed.length > CUSTOMIZATION_LIMITS.workspaceName) {
      return { ok: false, code: "limit", message: `工作区名称最多 ${CUSTOMIZATION_LIMITS.workspaceName} 个字符` };
    }
    if (/[\u0000-\u001f]/.test(trimmed)) return { ok: false, code: "invalid", message: "工作区名称包含控制字符" };
    const preferences = this.state.preferences;
    if (preferences.workspaces.length >= CUSTOMIZATION_LIMITS.workspaces) {
      return { ok: false, code: "limit", message: `最多保存 ${CUSTOMIZATION_LIMITS.workspaces} 个工作区，请先删除一个` };
    }
    const panelLayout = options.panelLayout ? boundedLayout(options.panelLayout) : null;
    if (options.panelLayout && !panelLayout) return { ok: false, code: "invalid", message: "面板布局快照非法，未保存工作区" };
    const preset: WorkspacePreset = {
      id: this.nextWorkspaceId(),
      name: trimmed,
      shortcuts: { ...preferences.shortcuts },
      toolbarHidden: [...preferences.toolbarHidden],
      toolbarOrder: preferences.toolbarOrder ? [...preferences.toolbarOrder] : null,
      menuHidden: [...preferences.menuHidden],
      panelLayout,
      createdAt: Date.now()
    };
    return this.commit({ ...preferences, workspaces: [...preferences.workspaces, preset] });
  }

  /** 应用工作区：恢复快捷键/工具栏/菜单，并交回面板几何快照给布局所有者。 */
  applyWorkspace(id: string): WorkspaceApplyResult {
    const preset = this.state.preferences.workspaces.find((entry) => entry.id === id);
    if (!preset) return { ok: false, code: "missing", message: "工作区不存在，可能已被删除" };
    const result = this.commit({
      ...this.state.preferences,
      shortcuts: { ...preset.shortcuts },
      toolbarHidden: [...preset.toolbarHidden],
      toolbarOrder: preset.toolbarOrder ? [...preset.toolbarOrder] : null,
      menuHidden: [...preset.menuHidden],
      activeWorkspace: preset.id
    });
    if (!result.ok) return result;
    return { ok: true, panelLayout: preset.panelLayout ? { ...preset.panelLayout } : null };
  }

  deleteWorkspace(id: string): CustomizationResult {
    if (!this.state.preferences.workspaces.some((preset) => preset.id === id)) {
      return { ok: false, code: "missing", message: "工作区不存在，可能已被删除" };
    }
    return this.commit({
      ...this.state.preferences,
      workspaces: this.state.preferences.workspaces.filter((preset) => preset.id !== id),
      activeWorkspace: this.state.preferences.activeWorkspace === id ? null : this.state.preferences.activeWorkspace
    });
  }

  /** 恢复全部出厂偏好（含工作区）。 */
  resetAll(): CustomizationResult {
    return this.commit(defaultPreferences());
  }

  exportJson(): string {
    return JSON.stringify(this.state.preferences, null, 2);
  }

  /** 导入偏好文件；版本失配或结构非法时拒绝并且不改动当前设置。 */
  importJson(text: string): CustomizationResult {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, code: "invalid", message: "偏好文件不是有效 JSON" };
    }
    const decoded = decodePreferences(raw);
    // 版本失配单独说清楚（报「格式非法」会让用户以为文件坏了）。
    if (!decoded.ok) {
      return { ok: false, code: "invalid", message: decoded.reason };
    }
    const result = this.commit(decoded.preferences);
    // 解码期被丢弃的条目必须回报，不能「导入成功」却静默少了设置。
    return result.ok && decoded.warnings.length ? { ok: true, warnings: decoded.warnings } : result;
  }

  private nextWorkspaceId(): string {
    const used = new Set(this.state.preferences.workspaces.map((preset) => preset.id));
    for (;;) {
      this.workspaceSequence += 1;
      const id = `ws-${Date.now().toString(36)}-${this.workspaceSequence}`;
      if (!used.has(id)) return id;
    }
  }
}

/**
 * 进程内共享的偏好仓库：面板与领域会话/外壳集成共用同一份内存状态。
 *
 * 惰性创建（首次使用时才探测本机存储），测试可以用 `setDefaultCustomizationStore` 换成
 * 注入替身或直接构造 `CustomizationStore`。
 */
let sharedStore: CustomizationStore | null = null;

export function defaultCustomizationStore(): CustomizationStore {
  sharedStore ??= new CustomizationStore();
  return sharedStore;
}

/** 替换共享仓库（测试/宿主注入）；传 null 让下一次调用重新探测本机存储。 */
export function setDefaultCustomizationStore(store: CustomizationStore | null): void {
  sharedStore = store;
}

/** 组合匹配：`=` 同时接受 `+`（Shift+=）的物理按键，与既有快捷键表一致。 */
function chordMatches(chord: Chord, input: { key: string; mod: boolean; alt: boolean; shift: boolean }): boolean {
  if (chord.mod !== input.mod || chord.alt !== input.alt) return false;
  if (chord.key === "=" && input.key === "+") return true;
  return chord.key === input.key && chord.shift === input.shift;
}

/**
 * 某个规范组合文本是否匹配这次按键（与 `matchCustomizationBinding` 同一套等价规则）。
 *
 * 供外壳判断「这个动作当前生效的组合是不是刚按下的这个」，例如改绑后旧出厂组合必须失效。
 */
export function chordMatchesEvent(text: string, event: ShortcutEventLike, isMac: boolean): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (isMac && event.ctrlKey) return false;
  if (!isMac && event.metaKey) return false;
  const key = eventKey(event);
  if (!key) return false;
  const parsed = parseChord(text);
  if (!parsed.ok || !parsed.chord) return false;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return chordMatches(parsed.chord, { key, mod, alt: event.altKey, shift: event.shiftKey });
}

/**
 * 在已保存的绑定里匹配一次按键。
 *
 * 只返回绑定的动作 id；调用方仍须经过自己的命令门/工具门，这是「搜索执行同一门禁动作」的
 * 同一原则。输入法合成、平台错误的修饰键与未知按键都返回 null。
 */
export function matchCustomizationBinding(
  preferences: CustomizationPreferences,
  event: ShortcutEventLike,
  isMac: boolean
): { actionId: string; chord: string } | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (isMac && event.ctrlKey) return null;
  if (!isMac && event.metaKey) return null;
  const key = eventKey(event);
  if (!key) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const input = { key, mod, alt: event.altKey, shift: event.shiftKey };
  for (const action of CUSTOMIZATION_ACTIONS) {
    const text = effectiveChord(preferences, action.id);
    if (!text) continue;
    const parsed = parseChord(text);
    if (!parsed.ok || !parsed.chord) continue;
    if (chordMatches(parsed.chord, input)) return { actionId: action.id, chord: formatChord(parsed.chord) };
  }
  return null;
}
