/**
 * 文字域（U67/U68/U69）的协议面：命令清单、参数形状与有界检查。
 *
 * 纯数据、零宿主依赖：这里**不**执行命令，也不复制内核校验；它只把「界面能发出的命令与参数
 * 外形」和「内核白名单」对齐，供面板、查找替换等界面与回归测试共用。真正的权威校验与拒绝
 * 仍是内核 `features/type/params.rs`（白名单外一律按能力关闭拒绝）。
 */

/** 抗锯齿方式（与内核 `ANTIALIAS_MODES` 同序）。 */
export const TYPECRAFT_ANTIALIAS_MODES = ["none", "sharp", "crisp", "strong", "smooth", "windows", "windowsLcd"] as const;
export type TypeCraftAntiAlias = (typeof TYPECRAFT_ANTIALIAS_MODES)[number];

/** 文字变形样式（短 id；`none` 表示取消变形）。 */
export const TYPECRAFT_WARP_STYLES = [
  "none",
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fisheye",
  "inflate",
  "squeeze",
  "twist"
] as const;
export type TypeCraftWarpStyle = (typeof TYPECRAFT_WARP_STYLES)[number];

/** OpenType 特性：界面上可切换的特性与它们对应的内核命令。 */
export const TYPECRAFT_OPEN_TYPE_FEATURES = [
  { id: "standardLigatures", label: "标准连字", command: "type.openType.standardLigatures" },
  { id: "contextualAlternates", label: "上下文替代", command: "type.openType.contextualAlternates" },
  { id: "discretionaryLigatures", label: "自由连字", command: "type.openType.discretionaryLigatures" },
  { id: "swash", label: "花体", command: "type.openType.swash" },
  { id: "oldstyle", label: "旧体数字", command: "type.openType.oldstyle" },
  { id: "stylisticAlternates", label: "风格替代", command: "type.openType.stylisticAlternates" },
  { id: "titlingAlternates", label: "标题替代", command: "type.openType.titlingAlternates" },
  { id: "ornaments", label: "花饰", command: "type.openType.ornaments" },
  { id: "ordinals", label: "序数", command: "type.openType.ordinals" },
  { id: "fractions", label: "分数", command: "type.openType.fractions" }
] as const;
export type TypeCraftOpenTypeId = (typeof TYPECRAFT_OPEN_TYPE_FEATURES)[number]["id"];

/** 段落选项（内核 `type.setStyle` 的 paragraph 键，全部已实现）。 */
export const TYPECRAFT_PARAGRAPH_ALIGNS = [
  "left",
  "center",
  "right",
  "justify",
  "justifyCenter",
  "justifyRight",
  "justifyAll"
] as const;
export type TypeCraftParagraphAlign = (typeof TYPECRAFT_PARAGRAPH_ALIGNS)[number];

export const TYPECRAFT_PARAGRAPH_KEYS = [
  "align",
  "firstLineIndent",
  "startIndent",
  "endIndent",
  "spaceBefore",
  "spaceAfter",
  "autoLeading",
  "direction",
  "hyphenate"
] as const;

/** 拼写动作（`list`/`suggest` 只读）。 */
export const TYPECRAFT_SPELL_ACTIONS = ["list", "change", "changeAll", "addToDictionary", "removeFromDictionary", "suggest"] as const;
export type TypeCraftSpellAction = (typeof TYPECRAFT_SPELL_ACTIONS)[number];

/** 查找动作：`find` 只移动搜索游标，其余改文本。 */
export const TYPECRAFT_FIND_ACTIONS = ["find", "change", "changeFind", "changeAll"] as const;
export type TypeCraftFindAction = (typeof TYPECRAFT_FIND_ACTIONS)[number];

/** 文字蒙版选区运算。 */
export const TYPECRAFT_MASK_OPERATIONS = ["new", "add", "subtract", "intersect"] as const;
export type TypeCraftMaskOperation = (typeof TYPECRAFT_MASK_OPERATIONS)[number];

/** 界面上一个可发出的文字命令（id + 中文标签 + 是否需要文字层目标）。 */
export type TypeCraftCommandEntry = {
  id: string;
  label: string;
  /** 需要先选中文字层（或活动层是文字层）。 */
  needsTextLayer: boolean;
  /** 只移动搜索游标/只读，不产生内容修改。 */
  readOnly?: boolean;
};

/**
 * 文字菜单/面板实际接入的命令清单。与内核白名单一一对应：
 * `tests/features/type` 与本清单核对，任何一侧漏登记都会失败。
 */
export const TYPECRAFT_COMMANDS: readonly TypeCraftCommandEntry[] = [
  { id: "type.info", label: "文字图层信息", needsTextLayer: true, readOnly: true },
  { id: "type.fonts", label: "字体列表", needsTextLayer: false, readOnly: true },
  { id: "type.characterStyle.list", label: "字符样式列表", needsTextLayer: false, readOnly: true },
  { id: "type.paragraphStyle.list", label: "段落样式列表", needsTextLayer: false, readOnly: true },
  { id: "type.convertToPointText", label: "转换为点文字", needsTextLayer: true },
  { id: "type.convertToParagraphText", label: "转换为段落文字", needsTextLayer: true },
  ...TYPECRAFT_OPEN_TYPE_FEATURES.map((feature) => ({ id: feature.command, label: `OpenType：${feature.label}`, needsTextLayer: true })),
  { id: "type.characterStyle.new", label: "新建字符样式", needsTextLayer: false },
  { id: "type.characterStyle.duplicate", label: "复制字符样式", needsTextLayer: false },
  { id: "type.characterStyle.delete", label: "删除字符样式", needsTextLayer: false },
  { id: "type.characterStyle.rename", label: "重命名字符样式", needsTextLayer: false },
  { id: "type.characterStyle.set", label: "字符样式选项", needsTextLayer: false },
  { id: "type.characterStyle.apply", label: "应用字符样式", needsTextLayer: true },
  { id: "type.characterStyle.redefine", label: "重定义字符样式", needsTextLayer: true },
  { id: "type.characterStyle.clearOverride", label: "清除字符样式覆盖", needsTextLayer: true },
  { id: "type.paragraphStyle.new", label: "新建段落样式", needsTextLayer: false },
  { id: "type.paragraphStyle.duplicate", label: "复制段落样式", needsTextLayer: false },
  { id: "type.paragraphStyle.delete", label: "删除段落样式", needsTextLayer: false },
  { id: "type.paragraphStyle.rename", label: "重命名段落样式", needsTextLayer: false },
  { id: "type.paragraphStyle.set", label: "段落样式选项", needsTextLayer: false },
  { id: "type.paragraphStyle.apply", label: "应用段落样式", needsTextLayer: true },
  { id: "type.paragraphStyle.redefine", label: "重定义段落样式", needsTextLayer: true },
  { id: "type.paragraphStyle.clearOverride", label: "清除段落样式覆盖", needsTextLayer: true },
  ...TYPECRAFT_ANTIALIAS_MODES.map((mode) => ({ id: `type.antiAlias.${mode}`, label: `抗锯齿：${mode}`, needsTextLayer: true })),
  { id: "type.warpText", label: "文字变形", needsTextLayer: true },
  { id: "type.createWorkPath", label: "创建 work path", needsTextLayer: true },
  { id: "type.convertToShape", label: "转换为形状", needsTextLayer: true },
  { id: "type.rasterizeTypeLayer", label: "栅格化文字", needsTextLayer: true },
  { id: "type.createSelection", label: "文字蒙版选区", needsTextLayer: true },
  { id: "edit.findAndReplaceText", label: "查找与替换文字", needsTextLayer: false },
  { id: "edit.checkSpelling", label: "拼写检查", needsTextLayer: false },
  { id: "type.resolveMissingFonts", label: "缺失字体", needsTextLayer: false },
  { id: "type.replaceAllMissingFonts", label: "全部替换缺失字体", needsTextLayer: false }
];

/** 命令是否在清单中（界面据此禁用入口，而不是在调用时才报错）。 */
export function isTypeCraftCommand(id: string): boolean {
  return TYPECRAFT_COMMANDS.some((entry) => entry.id === id);
}

/** 界面上可发出的写命令（排除只读项）。 */
export function typeCraftWriteCommands(): readonly TypeCraftCommandEntry[] {
  return TYPECRAFT_COMMANDS.filter((entry) => !entry.readOnly);
}

const MAX_NAME = 200;
const MAX_QUERY = 4096;
const MAX_WORD = 200;

function shortText(value: unknown, max = MAX_NAME): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= max;
}

/** 文字变形参数：样式必须在清单内，弯曲/扭曲为 ±100 的有限数。 */
export function buildWarpParams(input: {
  layer: number | null;
  style: TypeCraftWarpStyle;
  bend?: number;
  horizontalDistortion?: number;
  verticalDistortion?: number;
  orientation?: "horizontal" | "vertical";
}): Record<string, unknown> {
  const params: Record<string, unknown> = { style: input.style };
  if (input.layer !== null) params.layer = input.layer;
  for (const key of ["bend", "horizontalDistortion", "verticalDistortion"] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) params[key] = Math.max(-100, Math.min(100, value));
  }
  if (input.orientation) params.orientation = input.orientation;
  return params;
}

/** 查找/替换参数：空查询直接不构造，避免界面发出必然失败的调用。 */
export function buildFindReplaceParams(input: {
  find: string;
  replace?: string;
  action?: TypeCraftFindAction;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  forward?: boolean;
  allLayers?: boolean;
  layer?: number | null;
}): Record<string, unknown> | null {
  if (!shortText(input.find, MAX_QUERY)) return null;
  const params: Record<string, unknown> = { find: input.find, action: input.action ?? "changeAll" };
  if (input.replace !== undefined) {
    if ([...input.replace].length > MAX_QUERY) return null;
    params.replace = input.replace;
  }
  if (input.caseSensitive) params.caseSensitive = true;
  if (input.wholeWord) params.wholeWord = true;
  if (input.forward === false) params.forward = false;
  if (input.allLayers === false) params.allLayers = false;
  if (input.allLayers === false && input.layer != null) params.layer = input.layer;
  return params;
}

/** 拼写参数：局部替换必须带位置与替换文本。 */
export function buildSpellParams(input: {
  action: TypeCraftSpellAction;
  word?: string;
  replace?: string;
  layer?: number | null;
  start?: number;
  end?: number;
  allLayers?: boolean;
  suggestions?: number;
  ignore?: string[];
}): Record<string, unknown> | null {
  const params: Record<string, unknown> = { action: input.action };
  if (input.allLayers === false) params.allLayers = false;
  if (input.ignore?.length) params.ignore = input.ignore.filter((word) => shortText(word, MAX_WORD)).slice(0, 256);
  if (typeof input.suggestions === "number" && Number.isFinite(input.suggestions)) {
    params.suggestions = Math.max(0, Math.min(20, Math.round(input.suggestions)));
  }
  switch (input.action) {
    case "list":
      if (input.layer != null) params.layer = input.layer;
      return params;
    case "change":
      if (input.layer == null || typeof input.start !== "number" || typeof input.end !== "number") return null;
      if (input.replace === undefined) return null;
      return { ...params, layer: input.layer, start: input.start, end: input.end, replace: input.replace };
    case "changeAll":
      if (!shortText(input.word, MAX_WORD) || input.replace === undefined) return null;
      return { ...params, word: input.word, replace: input.replace };
    default:
      if (!shortText(input.word, MAX_WORD)) return null;
      return { ...params, word: input.word };
  }
}

/** 文字蒙版参数：必须有真实文字层目标；操作符固定四种。 */
export function buildTypeMaskParams(input: {
  layer: number | null;
  operation?: TypeCraftMaskOperation;
  antialias?: TypeCraftAntiAlias;
  removeLayer?: boolean;
}): Record<string, unknown> | null {
  if (input.layer === null) return null;
  const params: Record<string, unknown> = { layer: input.layer };
  if (input.operation) params.operation = input.operation;
  if (input.antialias) params.antialias = input.antialias;
  if (input.removeLayer) params.removeLayer = true;
  return params;
}

/** 字体替换映射：只接受「缺失字体 → 已安装字体」的有界字符串对。 */
export function buildFontReplacementMap(entries: readonly { from: string; to: string }[]): Record<string, string> | null {
  const map: Record<string, string> = {};
  for (const entry of entries.slice(0, 256)) {
    if (!shortText(entry.from) || !shortText(entry.to)) return null;
    map[entry.from] = entry.to;
  }
  return Object.keys(map).length ? map : null;
}
