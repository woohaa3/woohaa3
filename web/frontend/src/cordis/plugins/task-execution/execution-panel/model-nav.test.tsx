/**
 * ExecutionPanel 模型导航与 Dock 组合契约
 * （change: align-showcase-reference-ux，任务 2.1 / 2.2）。
 *
 * 锁定：
 * - `showModelSelector={false}` 时不渲染内联模型选择器；
 * - `showRun={false}` 时不渲染内联主操作（执行放到宿主 action 区）；
 * - `ExecutionPanelModelNav` 提供搜索、选中态与无结果态。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanel, ExecutionPanelModelNav } from "./ExecutionPanel.js";

const MODEL_CONFIG = {
	modelOptions: [
		{ value: "m", label: "模型 M", detail: "快速" },
		{ value: "n", label: "模型 N" },
	],
	defaultModel: "m",
	parameterSchemaByModel: {
		m: [{ key: "ratio", label: "比例", type: "select" as const, options: [{ value: "1:1", label: "1:1" }], defaultValue: "1:1" }],
		n: [],
	},
};

const BASE_PROPS = {
	taskKind: "image-generation" as const,
	surface: "dock" as const,
	modelConfig: MODEL_CONFIG,
	data: { title: "节点", panelPrompt: "提示词", parameters: { model: "m" } },
	onRun: () => undefined,
};

describe("ExecutionPanel Dock 组合", () => {
	it("默认渲染内联模型选择器与主操作", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} />);
		expect(html).toContain('aria-label="来源与模型"');
		expect(html).toContain("mc-panel__send");
	});

	it("showModelSelector=false 时不渲染内联模型选择器", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} showModelSelector={false} />);
		expect(html).not.toContain('aria-label="来源与模型"');
		// 参数菜单仍可用。
		expect(html).toContain('aria-label="生成参数"');
	});

	it("showRun=false 时不渲染内联主操作", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} showRun={false} />);
		expect(html).not.toContain("mc-panel__send");
	});

	it("showRun=false 且 showPolish=false 时不渲染 run 区", () => {
		const html = renderToStaticMarkup(
			<ExecutionPanel {...BASE_PROPS} showRun={false} showPolish={false} />,
		);
		expect(html).not.toContain("mc-panel__run-actions");
	});

	it("模型选择 trigger 不内联自管 onClick（避免与 Radix Trigger 双重 toggle 导致菜单开关抖动）", () => {
		// 结构回归：swallow 掉 Radix Trigger 后，trigger 按钮自身不应再绑定 onClick。
		// 这里以源码文本断言，避免 jsdom 下 Radix portal 的行为差异。
		const source = readFileSync(new URL("./model-selector.tsx", import.meta.url), "utf8");
		const modelTrigger = source.slice(source.indexOf("mc-panel__model-trigger"), source.indexOf("mc-panel__settings-trigger"));
		expect(modelTrigger).not.toContain("onClick");
	});
});

describe("ExecutionPanelModelNav", () => {
	it("渲染模型列表与唯一选中态", () => {
		const html = renderToStaticMarkup(
			<ExecutionPanelModelNav options={MODEL_CONFIG.modelOptions} model="m" onSelect={() => undefined} />,
		);
		expect(html).toContain('aria-label="搜索模型"');
		expect(html).toContain('role="listbox"');
		expect(html).toContain("模型 M");
		expect(html).toContain('aria-selected="true"');
		// 只有一个选中项。
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
	});
});
