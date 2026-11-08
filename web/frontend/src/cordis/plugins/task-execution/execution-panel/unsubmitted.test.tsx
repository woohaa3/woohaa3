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

describe("ExecutionPanel idle 视频节点", () => {
	it.each(["compact", "expanded"] as const)("%s 不显示未提交状态和配置说明", presentation => {
		const html = renderToStaticMarkup(
			<ExecutionPanel
				{...CONFIG}
				presentation={presentation}
				data={{ panelPrompt: "", taskStatus: "idle", parameters: { model: "agnes" } }}
			/>
		);
		expect(html).not.toContain("未提交 · 待配置");
		expect(html).not.toContain("选择模型并填写提示词后提交");
		expect(html).not.toContain("生成失败");
	});
});
