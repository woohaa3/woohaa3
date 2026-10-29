/**
 * Dock story 结构与交互（change: align-showcase-reference-ux，任务 2.3）。
 *
 * 断言：
 * - Dock 使用生产组件组合模型导航 + 编辑器；
 * - 搜索/选中/无结果态；
 * - Dock 内不出现重复的 inline model selector / send / polish，action 只在宿主级；
 * - 桌面与窄屏（390×844）舞台的切换与返回路径。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DockDeck } from "./dock-fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_CSS = readFileSync(
	path.join(HERE, "..", "..", "..", "frontend", "src", "cordis", "plugins", "task-execution", "execution-panel", "execution-panel.css"),
	"utf8",
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root!.render(node));
	return container;
}

function setInput(input: HTMLInputElement, value: string) {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("Dock story", () => {
	it("桌面呈现模型导航与编辑器分栏，Dock 内无重复执行/润色控件", () => {
		const el = mount(<DockDeck />);
		expect(el.querySelector('[aria-label="生成模型"]')).not.toBeNull();
		expect(el.querySelector('[role="listbox"][aria-label="选择生成模型"]')).not.toBeNull();
		// 右侧编辑器存在（生产 ExecutionPanel）。
		expect(el.querySelector(".mc-panel")).not.toBeNull();
		// Dock 内不重复 inline 模型选择器 / send / polish。
		expect(el.querySelector('.mc-panel__model-trigger[aria-label="选择生成模型"]')).toBeNull();
		expect(el.querySelector(".mc-panel__send")).toBeNull();
		expect(el.querySelector(".mc-panel__universal-polish")).toBeNull();
		// action 只在宿主级位置。
		expect(el.querySelector('[data-testid="host-run"]')).not.toBeNull();
	});

	it("搜索并选择模型：唯一选中态且编辑器切到该模型", () => {
		const el = mount(<DockDeck />);
		const search = el.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]');
		expect(search).not.toBeNull();
		setInput(search!, "通义");

		const options = el.querySelectorAll('[role="option"]');
		expect(options).toHaveLength(1);
		act(() => (options[0] as HTMLButtonElement).click());

		const selected = el.querySelectorAll('[role="option"][aria-selected="true"]');
		expect(selected).toHaveLength(1);
		expect(selected[0].textContent).toContain("通义万相 3");
	});

	it("搜索没有结果时显示明确空态且不切换模型", () => {
		const el = mount(<DockDeck />);
		const search = el.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]');
		setInput(search!, "不存在的模型");
		expect(el.querySelector('[role="status"]')?.textContent).toContain("没有匹配的模型");
		expect(el.querySelectorAll('[role="option"]')).toHaveLength(0);
		// 编辑器仍存在，没有被切到不存在的模型。
		expect(el.querySelector(".mc-panel")).not.toBeNull();
	});

	it("窄屏保留当前模型身份与返回模型列表的路径", () => {
		const el = mount(<DockDeck narrow />);
		const layout = el.querySelector(".mc-panel__dock-layout");
		expect(layout?.getAttribute("data-dock-view")).toBe("models");

		const option = el.querySelector<HTMLButtonElement>('[role="option"]');
		act(() => option!.click());
		expect(layout?.getAttribute("data-dock-view")).toBe("editor");
		expect(el.querySelector(".mc-panel__dock-back")).not.toBeNull();
		// 当前模型身份保留（唯一选中态）。
		expect(el.querySelector('[role="option"][aria-selected="true"]')).not.toBeNull();

		act(() => (el.querySelector(".mc-panel__dock-back") as HTMLButtonElement).click());
		expect(layout?.getAttribute("data-dock-view")).toBe("models");
	});
});

describe("Dock 样式", () => {
	it("提供分栏与窄屏堆叠规则", () => {
		expect(PANEL_CSS).toMatch(/\.mc-panel__dock-layout\s*\{[^}]*grid-template-columns/);
		expect(PANEL_CSS).toMatch(/@media \(max-width: 640px\)\s*\{[^}]*\.mc-panel__dock-layout/);
		expect(PANEL_CSS).toMatch(/\.mc-panel__model-nav\s*\{[^}]*grid-template-rows/);
	});
});
