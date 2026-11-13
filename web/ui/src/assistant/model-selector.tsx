import type { ComponentProps } from "react";
import { GenerationModelDirectory } from "./generation-directory.js";

export const ASSISTANT_SETUP_HINT = "尚未配置助手。连接一个助手即可开始，创作描述会保留在这里。";
export const ASSISTANT_SETUP_TOOLTIP = "尚未配置助手，点击这里配置。";
type SelectorProps = {
 model: string; options: readonly { value: string; label: string; detail?: string; provider?: string; sourceIdentity?: string; modelId?: string; disabled?: boolean }[];
 open: boolean; onOpenChange(open: boolean): void; onChange(value: string): void;
 label?: string; placeholder?: string; disabled?: boolean; onManage?(): void;
 /** Kept as a source-compatible property; selections now always close the model directory. */
 keepOpenOnModelSelect?: boolean;
 /** @deprecated Use GenerationParameters for reasoning effort. */
 variant?: { value: string; options: readonly { value: string; label: string; disabled?: boolean }[]; onChange(value: string): void };
};
export function AssistantListSelector(props: SelectorProps) {
 const entries = props.options.map(o => ({ identity: o.value, sourceIdentity: o.sourceIdentity ?? o.provider ?? "catalog", modelIdentity: o.value, label: o.label, modelId: o.modelId ?? o.value, sourceLabel: o.provider ?? "已配置来源", detail: o.detail, unavailableReason: o.disabled ? o.detail || "当前不可用" : undefined }));
 const sources = [...new Map(entries.map(e => [e.sourceIdentity, { identity: e.sourceIdentity, label: e.sourceLabel, status: "ready" as const }])).values()];
 return <GenerationModelDirectory entries={entries} sources={sources} selected={props.model} open={props.open} onOpenChange={props.onOpenChange} onSelect={entry => props.onChange(entry.identity)} onManage={props.onManage} disabled={props.disabled} placeholder={props.placeholder ?? props.label} />;
}
export const AssistantModelSelector = AssistantListSelector;
export function AssistantConnectionSelector({ empty, loading, ...props }: Omit<ComponentProps<typeof AssistantListSelector>, "label"> & { empty: boolean; loading?: boolean }) {
 if (empty && props.onManage) return <button type="button" className="mc-panel__model-trigger" disabled={props.disabled} onClick={props.onManage}>配置助手</button>;
 return <AssistantListSelector {...props} placeholder={loading ? "正在读取助手…" : props.placeholder ?? "来源与模型"} />;
}
