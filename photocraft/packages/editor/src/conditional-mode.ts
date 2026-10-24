/**
 * File › Automate › Conditional Mode Change（I291）。
 *
 * 固定引擎的 `file.automate.conditionalModeChange` 已经实现完整语义：`from` 可为 `"any"`
 * 或来源模式数组，`to` 是目标模式；当前模式已是目标、或不在 `from` 列表内时**不改文档**，
 * 返回 `{changed:false}`。本模块只把表单编译成该命令参数并回报是否真的改变。
 *
 * 与 `image.mode.*` 的区别：那条命令无条件转换；这条按来源模式条件执行，适合批处理式工作流。
 */

/** 条件分支可选的来源模式（与引擎接受的 `from` 名称一致）。 */
export const CONDITIONAL_SOURCE_MODES = ["rgb", "grayscale", "cmyk", "lab", "bitmap", "indexed", "duotone", "multichannel"] as const;
/** 目标模式：引擎只接受这四种。 */
export const CONDITIONAL_TARGET_MODES = ["rgb", "grayscale", "cmyk", "lab"] as const;

export type ConditionalModeSettings = {
  from: readonly (typeof CONDITIONAL_SOURCE_MODES[number])[];
  /** 任意来源（`"any"`）。勾选时忽略 `from`。 */
  anySource: boolean;
  to: (typeof CONDITIONAL_TARGET_MODES)[number];
};

export const DEFAULT_CONDITIONAL_MODE: ConditionalModeSettings = { from: [], anySource: true, to: "rgb" };

/** 编译成命令参数；未选来源且未勾选「任意」时返回 null（表单需先选择条件）。 */
export function buildConditionalMode(settings: ConditionalModeSettings): Record<string, unknown> | null {
  if (!CONDITIONAL_TARGET_MODES.includes(settings.to)) return null;
  if (!settings.anySource && settings.from.length === 0) return null;
  const from = settings.anySource ? "any" : settings.from.filter(mode => CONDITIONAL_SOURCE_MODES.includes(mode));
  if (from !== "any" && from.length === 0) return null;
  return { from, to: settings.to };
}

/** 表单状态是否真的会触发一次转换（当前模式已在目标或不在来源列表里时不会）。 */
export function willConvert(settings: ConditionalModeSettings, currentMode: string): boolean {
  const normalized = currentMode.toLowerCase() === "gray" ? "grayscale" : currentMode.toLowerCase();
  if (normalized === settings.to) return false;
  if (settings.anySource) return true;
  return settings.from.includes(normalized as (typeof CONDITIONAL_SOURCE_MODES)[number]);
}

/** 严格解码命令回执：只接受 `{changed:boolean, mode:string}`。 */
export function decodeConditionalModeResult(value: unknown): { changed: boolean; mode: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.changed !== "boolean" || typeof raw.mode !== "string" || !raw.mode) return null;
  return { changed: raw.changed, mode: raw.mode };
}
