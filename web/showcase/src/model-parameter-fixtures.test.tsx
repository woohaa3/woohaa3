/**
 * 模型参数面板查看页测试
 * （change: add-showcase-history-model-panels，任务 3.1–3.4；
 *  change: remove-model-placement-panel —— 面板移除模型摆放，MCP 模型生成独占面板）。
 *
 * 直接挂载生产 `ModelParameterPanel`，验证：
 * - 只有 model3d 与片场（composite-asset + extensionId="film-set"）渲染 MCP 区域；已下线的 generate/edit/shot 与不支持类型都不渲染面板；
 * - `disabledReason` 呈现可访问原因；
 * - clipboard adapter 的成功/失败反馈（绝不访问真实系统 clipboard）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelParameterPanel } from "../../frontend/src/cordis/plugins/task-execution/model-parameter-panel.js";
import { createCopyAdapter } from "./model-parameter-fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container.remove();
});

async function mount(ui: ReactElement) {
	root = createRoot(container);
	await act(async () => {
		root!.render(ui);
	});
}

const query = <T extends Element>(selector: string) => container.querySelector<T>(selector);

describe("ModelParameterPanel 模式能力", () => {
	it("model3d 显示 MCP 区域且不含模型摆放控件", async () => {
		await mount(<ModelParameterPanel nodeId="g1" nodeType="model3d" />);
		expect(container.textContent).toContain("MCP 模型生成");
		expect(container.textContent).not.toContain("模型摆放");
		expect(query('textarea[aria-label="MCP 服务器地址"]')).not.toBeNull();
		expect(query('textarea[aria-label="MCP 模型提示词指引"]')).not.toBeNull();
		// 不再有 offset/scale/yaw 数值控件或重置按钮。
		expect(container.querySelector('input[type="number"]')).toBeNull();
		expect(container.querySelector('input[type="range"]')).toBeNull();
		expect(container.textContent).not.toContain("重置模型位置");
	});

	it("edit/shot/generate 已下线不再渲染面板", async () => {
		for (const nodeType of ["edit", "shot", "generate"] as const) {
			await mount(<ModelParameterPanel nodeId={`${nodeType}-1`} nodeType={nodeType} />);
			expect(container.querySelector(".node-param-panel"), nodeType).toBeNull();
			expect(container.textContent, nodeType).toBe("");
			act(() => root?.unmount());
			container.remove();
			container = document.createElement("div");
			document.body.append(container);
		}
	});

	it("不支持模型能力的节点类型不渲染面板", async () => {
		await mount(<ModelParameterPanel nodeId="i1" nodeType="image" />);
		expect(container.querySelector(".node-param-panel")).toBeNull();
		expect(container.textContent).toBe("");
	});
});

describe("disabledReason", () => {
	it("原因以可访问文本显示", async () => {
		await mount(
			<ModelParameterPanel nodeId="d1" nodeType="model3d" disabledReason="画布正在同步，暂时无法读取模型。" />
		);
		const reason = query('[role="note"]')!;
		expect(reason.textContent).toContain("画布正在同步");
	});
});

describe("复制反馈（注入 adapter，不访问真实 clipboard）", () => {
	it("复制成功：显示成功反馈并保持 MCP 内容", async () => {
		const copy = createCopyAdapter(true);
		await mount(
			<ModelParameterPanel
				nodeId="c1"
				nodeType="model3d"
				mcpServerUrl="/mcp/model-canvas"
				copyText={copy.copyText}
			/>
		);
		const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "复制")!;
		await act(async () => {
			button.click();
		});
		await act(async () => {});
		expect(copy.calls).toEqual(["/mcp/model-canvas"]);
		const status = query('[data-copy-field="server"]')!;
		expect(status.getAttribute("data-status")).toBe("copied");
		expect(status.textContent).toContain("复制成功");
		expect(query<HTMLTextAreaElement>('textarea[aria-label="MCP 服务器地址"]')!.value).toBe("/mcp/model-canvas");
	});

	it("复制失败：显示失败反馈且不显示成功状态", async () => {
		const copy = createCopyAdapter(false);
		await mount(
			<ModelParameterPanel
				nodeId="c2"
				nodeType="model3d"
				mcpServerUrl="/mcp/model-canvas"
				copyText={copy.copyText}
			/>
		);
		const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "复制")!;
		await act(async () => {
			button.click();
		});
		await act(async () => {});
		const status = query('[data-copy-field="server"]')!;
		expect(status.getAttribute("data-status")).toBe("error");
		expect(status.textContent).toContain("复制失败");
		expect(container.textContent).not.toContain("复制成功");
	});

	it("adapter 抛错时降级为失败反馈", async () => {
		const copyText = vi.fn(async () => {
			throw new Error("clipboard denied");
		});
		await mount(
			<ModelParameterPanel nodeId="c3" nodeType="model3d" mcpServerUrl="/mcp/model-canvas" copyText={copyText} />
		);
		const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "复制")!;
		await act(async () => {
			button.click();
		});
		await act(async () => {});
		expect(query('[data-copy-field="server"]')!.getAttribute("data-status")).toBe("error");
	});
});
