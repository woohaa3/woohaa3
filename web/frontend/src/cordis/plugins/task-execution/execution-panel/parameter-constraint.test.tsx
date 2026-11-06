/**
 * ExecutionPanel 提交前参数约束提示
 * （change: 2026-11-05-improve-creator-workflow-ux，spec「创作状态」）。
 *
 * 枚举 / 数值范围越界时，面板必须在主操作附近给出「哪个字段、允许什么」的中文原因并
 * 真正禁用主操作，而不是把请求发给 Provider 再等一句泛化错误。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanel } from "./ExecutionPanel.js";

const CONFIG = {
	taskKind: "video-generation" as const,
	surface: "dock" as const,
	modelConfig: {
		modelOptions: [{ label: "Seedance", value: "seedance" }],
		defaultModel: "seedance",
		parameterSchemaByModel: {
			seedance: [
				{ key: "duration", label: "时长", type: "number" as const, minimum: 1, maximum: 10, unit: "s" },
				{
					key: "ratio", label: "比例", type: "select" as const,
					options: [{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }]
				}
			]
		}
	},
	onRun: () => undefined
};

const VALID_PARAMETERS = { model: "seedance", duration: 5, ratio: "16:9" };

function panelHtml(parameters: Record<string, unknown>): string {
	return renderToStaticMarkup(
		<ExecutionPanel
			{...CONFIG}
			data={{ title: "节点", panelPrompt: "一段动画", parameters }}
		/>
	);
}

function sendButton(html: string): string {
	const match = html.match(/<button[^>]*class="mc-panel__send[^"]*"[^>]*>/);
	if (!match) throw new Error("未找到主操作按钮");
	return match[0];
}

describe("ExecutionPanel 提交前参数约束提示", () => {
	it("数值超出上限时展示可读范围并禁用主操作", () => {
		const html = panelHtml({ ...VALID_PARAMETERS, duration: 99 });
		expect(html).toContain("时长不能大于 10s，当前为 99s");
		expect(html).toContain("mc-panel__errors");
		expect(sendButton(html)).toContain("disabled");
	});

	it("数值低于下限时展示可读范围并禁用主操作", () => {
		const html = panelHtml({ ...VALID_PARAMETERS, duration: 0 });
		expect(html).toContain("时长不能小于 1s，当前为 0s");
		expect(sendButton(html)).toContain("disabled");
	});

	it("枚举外的值展示允许选项并禁用主操作", () => {
		const html = panelHtml({ ...VALID_PARAMETERS, ratio: "4:3" });
		expect(html).toContain("比例只支持 16:9、9:16，当前为「4:3」");
		expect(sendButton(html)).toContain("disabled");
	});

	it("合法参数不展示约束错误且可执行", () => {
		const html = panelHtml(VALID_PARAMETERS);
		expect(html).not.toContain("不能大于");
		expect(html).not.toContain("不能小于");
		expect(html).not.toContain("只支持");
		expect(sendButton(html)).not.toContain("disabled");
	});
});

/**
 * 视频模型必填参数（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 与 Provider schema 的 `required` 对齐：缺宽高比 / 分辨率时主操作必须禁用，并说明缺哪个字段。
 */
const REQUIRED_CONFIG = {
	taskKind: "video-generation" as const,
	surface: "dock" as const,
	modelConfig: {
		modelOptions: [{ label: "Agnes", value: "agnes" }],
		defaultModel: "agnes",
		parameterSchemaByModel: {
			agnes: [
				{ key: "aspectRatio", label: "比例", type: "select" as const, required: true,
					options: [{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }] },
				{ key: "resolution", label: "分辨率", type: "select" as const, required: true,
					options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }] },
				{ key: "durationSeconds", label: "时长", type: "number" as const, required: true, minimum: 5, maximum: 12, unit: "秒" }
			]
		}
	},
	onRun: () => undefined
};

function requiredPanelHtml(parameters: Record<string, unknown>): string {
	return renderToStaticMarkup(
		<ExecutionPanel
			{...REQUIRED_CONFIG}
			data={{ title: "节点", panelPrompt: "一段动画", parameters }}
		/>
	);
}

describe("ExecutionPanel 视频必填参数", () => {
	it("缺宽高比时禁用主操作并提示字段", () => {
		const html = requiredPanelHtml({ model: "agnes", resolution: "720p", durationSeconds: 5 });
		expect(html).toContain("缺少必填参数：比例");
		expect(sendButton(html)).toContain("disabled");
	});

	it("缺分辨率时禁用主操作并提示字段", () => {
		const html = requiredPanelHtml({ model: "agnes", aspectRatio: "16:9", durationSeconds: 5 });
		expect(html).toContain("缺少必填参数：分辨率");
		expect(sendButton(html)).toContain("disabled");
	});

	it("时长越界时显示允许上限", () => {
		const html = requiredPanelHtml({ model: "agnes", aspectRatio: "16:9", resolution: "720p", durationSeconds: 13 });
		expect(html).toContain("时长不能大于 12秒");
		expect(sendButton(html)).toContain("disabled");
	});

	it("必填参数齐全时允许执行", () => {
		const html = requiredPanelHtml({ model: "agnes", aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 });
		expect(html).not.toContain("缺少必填参数");
		expect(sendButton(html)).not.toContain("disabled");
	});
});
