/**
 * 文字编辑格式快捷键与字号步进（I125/I127）。
 *
 * 只处理 Type 输入态；每次按键选择当前 UTF16 选区并写成一个文字草稿提交步骤，不做浏览器
 * 排版。字符格式是否真的应用到范围仍由固定引擎的 `type.setStyle` 决定。
 */
export type TextFormatCommand =
  | { kind: "style"; style: Partial<Record<"caps" | "underline" | "strikethrough" | "fauxBold" | "fauxItalic", boolean | string>> }
  | { kind: "step"; field: "size" | "leading" | "leadingBy" | "baselineShiftBy" | "trackingBy" | "kerningBy"; amount: number }
  | { kind: "hyphenate" };

type KeyInput = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean };

/** 字号步进：默认 2pt，Alt/Option 为 10pt，方向由 `.` / `,` 决定。 */
export function resolveFontSizeStep(event: KeyInput, isMac: boolean): number | null {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (!mod || !event.shiftKey || event.altKey) return null;
  if (event.code === "Period" || event.key === ">") return event.altKey ? 10 : 2;
  if (event.code === "Comma" || event.key === "<") return -(event.altKey ? 10 : 2);
  return null;
}

/** Type 编辑格式组合；返回 `null` 表示不归文字格式处理。 */
export function resolveTextFormatShortcut(event: KeyInput, isMac: boolean): TextFormatCommand | null {
  if (event.ctrlKey && event.metaKey) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  if (mod && event.shiftKey && !event.altKey) {
    switch (event.code || "") {
      case "KeyK": return { kind: "style", style: { caps: "all" } };
      case "KeyU": return { kind: "style", style: { underline: true } };
      case "KeyB": return { kind: "style", style: { fauxBold: true } };
      case "KeyI": return { kind: "style", style: { fauxItalic: true } };
      case "Slash": return { kind: "style", style: { strikethrough: true } };
    }
  }
  if (mod && event.altKey && event.shiftKey && (event.code === "KeyH" || event.key.toLowerCase() === "h")) return { kind: "hyphenate" };
  if (event.altKey && !mod) {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowUp") return event.shiftKey ? { kind: "step", field: "baselineShiftBy", amount: step } : { kind: "step", field: "leadingBy", amount: step };
    if (event.key === "ArrowDown") return event.shiftKey ? { kind: "step", field: "baselineShiftBy", amount: -step } : { kind: "step", field: "leadingBy", amount: -step };
    if (event.key === "ArrowLeft") return { kind: "step", field: event.shiftKey ? "trackingBy" : "kerningBy", amount: -(event.shiftKey ? 10 : event.ctrlKey || event.metaKey ? 10 : 1) };
    if (event.key === "ArrowRight") return { kind: "step", field: event.shiftKey ? "trackingBy" : "kerningBy", amount: event.shiftKey ? 10 : event.ctrlKey || event.metaKey ? 10 : 1 };
  }
  return null;
}
