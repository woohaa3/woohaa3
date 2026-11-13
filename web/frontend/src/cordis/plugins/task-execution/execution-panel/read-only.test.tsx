/**
 * ExecutionPanel 会话只读门禁
 * （change: 2026-09-30-hide-offline-blocking-from-execution-panel）。
 *
 * 只读会话不再通过 `blockingReasons` 在面板里重复说明（由左下角同步状态控件承载），
 * 但主操作必须仍然**真正禁用**：即使提示词非空、没有 blocking reason，也不可提交。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionPanel } from "./ExecutionPanel.js";

const BASE_PROPS = {
	taskKind: "image-generation" as const,
	surface: "dock" as const,
	modelConfig: {
		modelOptions: [{ label: "M", value: "m" }],
		defaultModel: "m",
		parameterSchemaByModel: {}
	},
	data: { title: "节点", panelPrompt: "一只猫", parameters: { model: "m" } },
	onRun: () => undefined
};

function sendButton(html: string): string {
	const match = html.match(/<button[^>]*class="mc-panel__send[^"]*"[^>]*>/);
	if (!match) throw new Error("未找到主操作按钮");
	return match[0];
}

describe("ExecutionPanel 会话只读", () => {
	it("提示词非空且无阻止原因时可执行", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} />);
		expect(sendButton(html)).not.toContain("disabled");
	});

	it("readOnly 时主操作禁用，即使提示词非空且无阻止原因", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} readOnly />);
		expect(sendButton(html)).toContain("disabled");
		// 只读不再产生面板内阻止原因文案。
		expect(html).not.toContain("mc-panel__errors");
	});

	it("allowEmptySubmit 也不能绕过 readOnly", () => {
		const html = renderToStaticMarkup(
			<ExecutionPanel
				{...BASE_PROPS}
				readOnly
				allowEmptySubmit
				data={{ title: "节点", panelPrompt: "", parameters: { model: "m" } }}
			/>
		);
		expect(sendButton(html)).toContain("disabled");
	});
});

describe("ExecutionPanel 必填参考槽位", () => {
	it("必填槽位未填充时主操作禁用并显示稳定原因", () => {
		// 必填参考槽位是「能不能跑」的问题：缺控制图就提交，产物看起来正常、
		// 只是完全没照结构约束，比直接失败难查得多。
		const html = renderToStaticMarkup(
			<ExecutionPanel {...BASE_PROPS} blockingReasons={["缺少必填参考槽位：控制图"]} />
		);
		expect(sendButton(html)).toContain("disabled");
		expect(html).toContain("缺少必填参考槽位：控制图");
	});

	it("填充后原因消失、主操作恢复", () => {
		const html = renderToStaticMarkup(<ExecutionPanel {...BASE_PROPS} blockingReasons={[]} />);
		expect(sendButton(html)).not.toContain("disabled");
	});
});
