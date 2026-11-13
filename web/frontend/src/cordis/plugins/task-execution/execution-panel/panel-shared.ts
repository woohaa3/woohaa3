import { summarizeParameters, migratePresentedParameters } from "@woohaa3/contracts";
import { generationParameterError } from "@woohaa3/ui/assistant";
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
	return summarizeParameters(fields, parameters);
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
    const previousFields = config.parameterSchemaByModel?.[String(parameters.model ?? config.defaultModel)] ?? [];
    const kept = migratePresentedParameters(previousFields, fields, parameters);
	return { model: nextModel, ...defaults, ...kept };
}

/**
 * 面板打开/恢复草稿时的起始参数：**同样**并入该模型的默认值（A9）。
 *
 * `parametersAfterModelSwitch` 只在切换模型时跑，首次打开面板时 `parameters` 是空对象，
 * schema 默认值过去只用于渲染控件、没有被写进提交草稿。于是界面上显示
 * 「720p · 5」，请求体里却没有 `resolution`，Provider 直接拒绝
 * `field 'resolution' is required`（2026-10-24 preflight #1 / 审片 A9）。
 *
 * 已有值优先（恢复的草稿、节点上保存的参数不被覆盖），只补缺。
 */
export function parametersOnOpen(
	config: ExecutionPanelModelConfig,
	parameters: Record<string, unknown>,
	model: string,
): Record<string, unknown> {
	const defaults = config.defaultsByModel?.[model] ?? {};
	const merged: Record<string, unknown> = { ...defaults };
	for (const [key, value] of Object.entries(parameters)) {
		// 只有真正的值才算「已有」：null/空串不压掉默认值。
		if (value === undefined) continue;
		merged[key] = value;
	}
	return { ...merged, model };
}

/**
 * 提交前按参数表核对必填字段（A9）。
 *
 * schema 的 `required` 在投影时已由 Provider 目录带过来；缺字段时不要让请求发出去再等
 * Provider 报错——那时用户只看到一句英文错误，不知道少了哪一项。
 */
export function missingRequiredParameters(
	config: ExecutionPanelModelConfig,
	parameters: Record<string, unknown>,
	model: string,
): ExecutionPanelParameterField[] {
	const fields = config.parameterSchemaByModel?.[model] ?? [];
	return fields.filter((field) => {
		if (!field.required) return false;
		if (hiddenBy(field, parameters)) return false;
		const value = parameters[field.key];
		return value === undefined || value === null || value === "";
	});
}

/**
 * 提交前的参数值约束提示（枚举 / 数值范围）。
 *
 * 目录已经把 Provider 的 `enum` / `minimum` / `maximum` 投影进参数表。值越界或不在枚举里时
 * 不要让请求发出去再等 Provider 回一句泛化错误——那时用户不知道是哪个字段、允许什么范围。
 * 只在字段可见且有值时校验：缺失值由 `missingRequiredParameters` 负责，两者合并成同一份
 * 「提交前可理解提示」。
 *
 * 返回可直接展示的中文句子，顺序与参数表一致，便于稳定断言。
 */
export function parameterViolationReasons(
	fields: ReadonlyArray<ExecutionPanelParameterField>,
	parameters: Record<string, unknown>,
): string[] {
    return fields.filter(field => !hiddenBy(field, parameters)).flatMap(field => {
      const error = generationParameterError(field, parameters);
      return error ? [error] : [];
    });
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

