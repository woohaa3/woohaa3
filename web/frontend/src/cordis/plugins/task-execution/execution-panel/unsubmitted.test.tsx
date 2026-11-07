/**
 * 未提交视频节点的执行面板文案
 * （change: 2026-11-06-guard-video-generation-inputs，N12）。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanel } from "./ExecutionPanel.js";

const CONFIG = {
	taskKind: "video-generation" as const,
	surface: "dock" as const,
	modelConfig: {
		modelOptions: [{ label: "Agnes", value: "agnes" }],
		defaultModel: "agnes",
		parameterSchemaByModel: { agnes: [] }
	},
	onRun: () => undefined
};

describe("ExecutionPanel 未提交视频节点", () => {
	it("显示未提交/待配置并提示下一步，而不是失败", () => {
		const html = renderToStaticMarkup(
			<ExecutionPanel
				{...CONFIG}
				data={{ panelPrompt: "", taskStatus: "idle", unsubmitted: true, parameters: { model: "agnes" } }}
			/>
		);
		expect(html).toContain("未提交 · 待配置");
		expect(html).toContain("选择模型并填写提示词后提交");
		expect(html).not.toContain("生成失败");
	});

	it("普通 idle 节点不显示未提交文案", () => {
		const html = renderToStaticMarkup(
			<ExecutionPanel
				{...CONFIG}
				data={{ panelPrompt: "一段动画", taskStatus: "idle", parameters: { model: "agnes" } }}
			/>
		);
		expect(html).not.toContain("未提交 · 待配置");
	});
});
