import { useEffect, useState } from "react";
import { changedParameterKeys, orderParameterFields, summarizeParameters, validPresentedParameter, validateAgainstSchema, type PresentableParameter, type PptaskParameterControl } from "@woohaa3/contracts";
import { Popover } from "../primitives/Popover.js";
import { ChevronDownIcon } from "../icons/index.js";
import { ParameterField } from "./parameter-field.js";
export interface GenerationParameterField extends PresentableParameter {
  type?: "select" | "number" | "text" | "boolean" | "textarea" | "unsupported";
  control?: "slider"; semantic?: PptaskParameterControl; required?: boolean; adaptiveValue?: string;
}
export function generationParameterError(field: GenerationParameterField, values: Record<string, unknown>): string {
  const value = values[field.key];
  if (field.type === "unsupported") return field.required && (value === undefined || !validateAgainstSchema(value, field.schema).ok) ? `${field.label}需要专用参数面板提供有效值` : "";
  if (value === undefined || value === null) return field.required ? `请填写${field.label}` : "";
  if (value === "") return field.required || field.type === "number" ? `请填写${field.label}` : "";
  if (field.type === "select" && !field.options?.some(o => o.value === String(value))) return `${field.label}只支持 ${field.options?.map(o => o.label).join("、")}，当前为「${String(value)}」`;
  if (field.type === "number" && typeof value === "number") {
    const unit = field.unit ?? "";
    if (field.minimum !== undefined && value < field.minimum) return `${field.label}不能小于 ${field.minimum}${unit}，当前为 ${value}${unit}`;
    if (field.maximum !== undefined && value > field.maximum) return `${field.label}不能大于 ${field.maximum}${unit}，当前为 ${value}${unit}`;
  }
  return validPresentedParameter(field, value) ? "" : `${field.label}的值不符合当前模型约束`;
}
export function GenerationParameters({ fields, parameters, open, onOpenChange, onChange, onReset, disabled, summary: summaryOverride }: {
  fields: readonly GenerationParameterField[]; parameters: Record<string, unknown>; open: boolean;
  onOpenChange(open: boolean): void; onChange(patch: Record<string, unknown>): void; onReset?(): void; disabled?: boolean; summary?: string;
}) {
  const [advanced, setAdvanced] = useState(false);
  const visible = orderParameterFields(fields.filter(f => !f.hiddenWhen?.some(r => parameters[r.field] === r.equals)));
  const errors = visible.map(f => generationParameterError(f, parameters));
  const hasAdvancedError = visible.some((f, index) => f.presentation?.section !== "common" && !!errors[index]);
  useEffect(() => { if (hasAdvancedError) setAdvanced(true); }, [hasAdvancedError]);
  const changed = changedParameterKeys(visible, parameters);
  const summary = summaryOverride ?? summarizeParameters(visible, parameters);
  const common = visible.filter((f, index) => f.presentation?.section === "common" || !!errors[index]);
  const extra = visible.filter(f => !common.includes(f));
  const locked = new Map<string, string>();
  visible.forEach(f => Object.keys(f.requiresByValue?.[String(parameters[f.key] ?? "")] ?? {}).forEach(key => locked.set(key, f.label)));
  const render = (f: GenerationParameterField) => <div key={f.key} data-parameter={f.key}>
    {f.type === "unsupported" ? <span>{f.label}：由专用面板编辑</span> : <ParameterField field={f} value={parameters[f.key]} lockedBy={locked.get(f.key)} onChange={value => onChange({ ...f.requiresByValue?.[String(value)], [f.key]: value })} />}
    {generationParameterError(f, parameters) ? <small className="generation-parameters__error">{generationParameterError(f, parameters)}</small> : null}
  </div>;
  return <div className="mc-panel__settings"><Popover open={open && fields.length > 0 && !disabled} onOpenChange={onOpenChange} side="top" align="start" className="generation-parameters mc-panel__settings-menu" label="生成参数" trigger={
    <button type="button" className="mc-panel__settings-trigger" aria-label="生成参数" disabled={disabled || !fields.length} title={summary || (!fields.length ? "默认参数" : "生成参数")}><span className="mc-panel__settings-summary">{summary || (!fields.length ? "默认参数" : "生成参数")}</span><ChevronDownIcon className="mc-panel__chevron" /></button>}>
    <header className="generation-parameters__header"><strong>生成参数</strong><button type="button" onClick={() => { if (onReset) onReset(); else onChange(Object.fromEntries(fields.map(f => [f.key, f.defaultValue]))); }}>恢复默认</button></header>
    <div className="generation-parameters__body">{common.map(render)}{extra.length ? <><button type="button" className="generation-parameters__advanced" onClick={() => setAdvanced(v => !v)}>高级参数{changed.filter(key => extra.some(f => f.key === key)).length ? `（${changed.filter(key => extra.some(f => f.key === key)).length} 项修改）` : ""}<ChevronDownIcon size={14} /></button>{advanced ? extra.map(render) : null}</> : null}</div>
  </Popover></div>;
}
const effortLabels: Record<string, string> = { none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大", ultra: "超高" };
export function ReasoningParameters({ value, options, onChange, ...props }: { value: string; options: readonly string[]; onChange(value: string): void; open: boolean; onOpenChange(open: boolean): void; disabled?: boolean }) {
  return <GenerationParameters {...props} summary={value ? `思考：${effortLabels[value] ?? value}` : undefined} parameters={{ reasoningEffort: value }} fields={options.length ? [{ key: "reasoningEffort", label: "思考强度", type: "select", options: [{ value: "", label: "默认" }, ...options.map(value => ({ value, label: effortLabels[value] ?? value }))], defaultValue: "", presentation: { section: "common", summaryOrder: 0 } }] : []} onChange={patch => onChange(String(patch.reasoningEffort ?? ""))} />;
}
