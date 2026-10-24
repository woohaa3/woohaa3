/**
 * 文字字符/段落样式控件（I114）。
 *
 * 只编辑已由原生 `type.setStyle` 拥有的字段：行距、字距（1/1000 em）、基线偏移、
 * 水平/垂直缩放、字重、下划线/删除线、连字、字偶距、首行/左右缩进、段前/段后与连字符。
 *
 * 所有值都进入当前文字草稿；内核复核范围，确认时才作为一步历史提交。组件不做排版。
 */
import {ArithmeticInput} from "./arithmetic-input.js";
import type {EditorTextStyle, EditorTextStyleDetail} from "./editor-view-model.js";
import type {NumericUnit} from "./numeric-expression.js";

type Props = {
  style: EditorTextStyleDetail | null;
  /** 当前字号，用于「自动行距」的显示基准。 */
  size: number;
  disabled: boolean;
  onChange: (patch: EditorTextStyleDetail) => void;
};

const number = (
  label: string, value: number | undefined, min: number, max: number, step: number,
  onCommit: (next: number) => void, disabled: boolean, key: string, unit?: NumericUnit
) => (
  <label key={key}>{label}
    <ArithmeticInput invalidate min={min} max={max} step={step} disabled={disabled}
      units={unit ? {unit} : undefined}
      value={value === undefined ? "" : String(Math.round(value * 100) / 100)}
      onChange={event => {
        const next = Number(event.currentTarget.value);
        if (Number.isFinite(next) && next >= min && next <= max) onCommit(next);
      }}/>
  </label>
);

const toggle = (label: string, checked: boolean | undefined, onChange: (next: boolean) => void, disabled: boolean, key: string) => (
  <label key={key}><input type="checkbox" checked={checked === true} disabled={disabled}
    onChange={event => onChange(event.currentTarget.checked)}/>{label}</label>
);

export function TextStyleControls({style, size, disabled, onChange}: Props) {
  const leading = style?.leading;
  return <section className="photo-editor__options-group" aria-label="文字样式" data-text-style="true">
    {number("行距", leading ?? Math.round(size * 1.2 * 100) / 100, 0.01, 5000, 0.5, next => onChange({leading: next}), disabled, "leading", "pt")}
    {number("字距", style?.tracking, -1000, 10000, 10, next => onChange({tracking: next}), disabled, "tracking")}
    {number("基线偏移", style?.baselineShift, -5000, 5000, 0.5, next => onChange({baselineShift: next}), disabled, "baselineShift", "pt")}
    {number("水平缩放", style?.horizontalScale, 1, 1000, 1, next => onChange({horizontalScale: next}), disabled, "horizontalScale", "%")}
    {number("垂直缩放", style?.verticalScale, 1, 1000, 1, next => onChange({verticalScale: next}), disabled, "verticalScale", "%")}
    {number("字重", style?.weight, 100, 900, 50, next => onChange({weight: next}), disabled, "weight")}
    <label>字偶距<select value={style?.kerning ?? "metrics"} disabled={disabled}
      onChange={event => onChange({kerning: event.currentTarget.value as EditorTextStyleDetail["kerning"]})}>
      <option value="metrics">度量</option><option value="optical">视觉</option><option value="off">无</option>
    </select></label>
    {toggle("斜体", style?.italic, next => onChange({italic: next}), disabled, "italic")}
    {toggle("下划线", style?.underline, next => onChange({underline: next}), disabled, "underline")}
    {toggle("删除线", style?.strikethrough, next => onChange({strikethrough: next}), disabled, "strikethrough")}
    {toggle("连字", style?.ligatures, next => onChange({ligatures: next}), disabled, "ligatures")}
    {toggle("自由连字", style?.discretionaryLigatures, next => onChange({discretionaryLigatures: next}), disabled, "discretionaryLigatures")}
    {toggle("连字符", style?.hyphenate, next => onChange({hyphenate: next}), disabled, "hyphenate")}
    {number("首行缩进", style?.firstLineIndent, -5000, 5000, 0.5, next => onChange({firstLineIndent: next}), disabled, "firstLineIndent", "pt")}
    {number("左缩进", style?.startIndent, -5000, 5000, 0.5, next => onChange({startIndent: next}), disabled, "startIndent", "pt")}
    {number("右缩进", style?.endIndent, -5000, 5000, 0.5, next => onChange({endIndent: next}), disabled, "endIndent", "pt")}
    {number("段前", style?.spaceBefore, 0, 5000, 0.5, next => onChange({spaceBefore: next}), disabled, "spaceBefore", "pt")}
    {number("段后", style?.spaceAfter, 0, 5000, 0.5, next => onChange({spaceAfter: next}), disabled, "spaceAfter", "pt")}
  </section>;
}

/** 样式补丁里出现任一字段时，说明用户确实改了该组选项。 */
export function hasTextStyleFields(style: EditorTextStyle["style"]): boolean {
  return !!style && Object.keys(style).length > 0;
}
