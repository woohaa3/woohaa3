/**
 * 执行面板共享工具与 hooks
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出）。
 */
import { useEffect } from "react";
import { isExecutionBusy } from "./run-snapshot.js";
import type {
	ExecutionPanelModelConfig,
	ExecutionPanelParameterField,
	ExecutionPanelStatus,
} from "./types.js";

export function isBusy(status: ExecutionPanelStatus | undefined): boolean {
	return isExecutionBusy(status);
}

export function readParameters(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** 秒 → “mm:ss.xx”（对齐源工程 formatEditorVideoTime）。 */
export function formatVideoTime(seconds: number): string {
	const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
	return `${Math.floor(safe / 60)
		.toString()
		.padStart(2, "0")}:${(safe % 60).toFixed(2).padStart(5, "0")}`;
}

export function hiddenBy(
	field: ExecutionPanelParameterField,
	parameters: Record<string, unknown>,
): boolean {
	return (field.hiddenWhen ?? []).some(
		(rule) => parameters[rule.field] === rule.equals,
	);
}

export function summarize(
	fields: ReadonlyArray<ExecutionPanelParameterField>,
	parameters: Record<string, unknown>,
): string {
	return fields
		.filter((field) => !hiddenBy(field, parameters))
		.flatMap((field) => {
			if (field.type !== "select" && field.control !== "slider") return [];
			const value = parameters[field.key] ?? field.defaultValue;
			if (value === undefined || value === null || value === "") return [];
			const label = field.options?.find((option) => option.value === String(value))?.label ?? String(value);
			return [`${label}${field.unit ?? ""}`];
		})
		.join(" · ");
}

/**
 * 切换模型后的起始参数。
 *
 * 不同模型家族的 schema 可能不同（Gemini / GPT Image 用分辨率 + 比例，其它模型
 * 仍是像素尺寸；quality 的枚举也不一致）。切换时以新模型的默认值为底，只保留
 * 新 schema 里仍合法且同名的旧值，避免把旧枚举（如 `hd`、像素 `size`）提交给
 * 新模型后被服务端 schema 校验拒绝。
 */
export function parametersAfterModelSwitch(
	config: ExecutionPanelModelConfig,
	parameters: Record<string, unknown>,
	nextModel: string,
): Record<string, unknown> {
	const fields = config.parameterSchemaByModel?.[nextModel] ?? [];
	const defaults = config.defaultsByModel?.[nextModel] ?? {};
	const kept: Record<string, unknown> = {};
	for (const field of fields) {
		if (!Object.hasOwn(parameters, field.key)) continue;
		const value = parameters[field.key];
		if (field.type === "select" && field.options?.length) {
			if (!field.options.some((option) => option.value === String(value))) continue;
		}
		if (field.type === "number" && typeof value === "number") {
			if (field.minimum !== undefined && value < field.minimum) continue;
			if (field.maximum !== undefined && value > field.maximum) continue;
		}
		kept[field.key] = value;
	}
	return { model: nextModel, ...defaults, ...kept };
}

/**
 * 面板局部 Escape 路由（change: 2026-09-28-align-execution-reference-and-expansion，
 * design D7）。
 *
 * 由**最内层的常驻表面**拥有：冒泡阶段消费 Esc 并关闭自己，`stopImmediatePropagation`
 * 阻止同一目标上的其它 layer 与继续冒泡。返回 false 时不消费，交给更外层（如收起/关闭
 * panel）。
 *
 * 仅用于**无法交给 primitive** 的 panel/expanded 层级路由（例如 execution host 的
 * presentation 收敛）；可迁移的浮层（菜单/设置/picker）改由受控 primitive 的 dismiss
 * 承担，不再注册本 hook。
 */
export function useEscapeLayer(active: boolean, onEscape: (event: KeyboardEvent) => boolean | void) {
	useEffect(() => {
		if (!active) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const handled = onEscape(event);
			if (handled === false) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		globalThis.addEventListener("keydown", onKeyDown);
		return () => globalThis.removeEventListener("keydown", onKeyDown);
	}, [active, onEscape]);
}

