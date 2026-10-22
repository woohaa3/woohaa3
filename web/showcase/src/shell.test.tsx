/**
 * Showcase 壳层与 diagnostics 验收
 * （change: 2026-09-29-refresh-showcase-shell，任务 2.1–2.4 / 3.1–3.2 / 3.4）。
 *
 * 覆盖：
 * - 紧凑品牌工具栏 + story header 语义层级；
 * - 主题 segmented control 为单选、不可取消，且切换走同一 Theme Service；
 * - diagnostics 默认收起、计数随事件更新但不抢焦点、展开后保留稳定 JSON/test id；
 * - fixed production surface 的 Showcase-scoped containment 规则（读 CSS）。
 *
 * @vitest-environment jsdom
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "../.ladle/components.js";
import { ShowcaseSidebar } from "./shell/ShowcaseSidebar.js";
import { showcaseThemeService } from "./theme.js";
import { OperationLogPanel, ProductionFixtureHeader } from "./fixtures/stage.js";
import { clearOperations, operationEntries, recordOperation, OPERATIONS } from "./fixtures/operations.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOWCASE_CSS = readFileSync(path.join(HERE, "showcase.css"), "utf8");
const SHOWCASE_PACKAGE = JSON.parse(
	readFileSync(path.join(HERE, "..", "package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	clearOperations();
	showcaseThemeService.select("default");
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container = null;
	document.body.innerHTML = "";
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(<>{node}</>);
	});
	await act(async () => {});
	return container;
}

async function click(element: Element | null): Promise<void> {
	expect(element).not.toBeNull();
	await act(async () => {
		(element as HTMLElement).click();
	});
}

async function press(element: Element | null, key: string): Promise<void> {
	expect(element).not.toBeNull();
	await act(async () => {
		(element as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
		(element as HTMLElement).dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
	});
}

describe("Showcase 壳层", () => {
	it("渲染紧凑品牌工具栏与 story 内容区", async () => {
		const el = await mount(
			<Provider>
				<div data-testid="story-root">story</div>
			</Provider>,
		);
		expect(el.querySelector(".showcase__brand-name")?.textContent).toContain("Woohaa Component Lab");
		expect(el.querySelector(".showcase__toolbar")).not.toBeNull();
		expect(el.querySelector(".showcase__content [data-testid='story-root']")).not.toBeNull();
	});

	it("story header 使用语义化层级并保留可查询文案", async () => {
		const el = await mount(
			<ProductionFixtureHeader title="图片 · 生产组合" note="prompt 来自生产组件。" />,
		);
		const heading = el.querySelector("h1.showcase__story-title");
		expect(heading?.textContent).toBe("图片 · 生产组合");
		expect(el.querySelector(".showcase__story-note")?.textContent).toContain("生产组件");
		expect(el.textContent).toContain("ModelExecutionHost");
	});
});

describe("主题 segmented control", () => {
	it("default 初始选中，切换 sentinel 走 Theme Service 且不重置 story", async () => {
		const el = await mount(
			<Provider>
				<div data-testid="story-root">story</div>
			</Provider>,
		);
		const toggle = el.querySelector(".showcase__theme-toggle")!;
		expect(toggle.getAttribute("data-theme-id")).toBe("default");
		expect(el.querySelector(".showcase__story-header")).toBeNull();

		const sentinel = el.querySelector<HTMLButtonElement>(
			'.showcase__theme-option[aria-label="哨兵主题"]',
		)!;
		await click(sentinel);
		expect(toggle.getAttribute("data-theme-id")).toBe("sentinel");
		expect(showcaseThemeService.getSnapshot().id).toBe("sentinel");
		// story 内容未被重置。
		expect(el.querySelector("[data-testid='story-root']")?.textContent).toBe("story");
	});

	it("再次激活当前项不会取消到无主题", async () => {
		const el = await mount(
			<Provider>
				<div />
			</Provider>,
		);
		const sentinel = el.querySelector<HTMLButtonElement>(
			'.showcase__theme-option[aria-label="哨兵主题"]',
		)!;
		await click(sentinel);
		await click(sentinel);
		expect(showcaseThemeService.getSnapshot().id).toBe("sentinel");
		expect(el.querySelector(".showcase__theme-toggle")?.getAttribute("data-theme-id")).toBe("sentinel");
		// 至少有一个选项处于选中态（role=radio + aria-checked）。
		const checked = el.querySelectorAll('.showcase__theme-option[aria-checked="true"]');
		expect(checked).toHaveLength(1);
	});

	it("主题选项声明为 radiogroup 内的 radio", async () => {
		const el = await mount(
			<Provider>
				<div />
			</Provider>,
		);
		expect(el.querySelector('[role="radiogroup"][aria-label="主题 preset"]')).not.toBeNull();
		expect(el.querySelectorAll('[role="radio"]')).toHaveLength(2);
	});
});

describe("fixture 操作记录 diagnostics", () => {
	it("初始收起，展开后显示稳定 JSON 与 data-count", async () => {
		const el = await mount(<OperationLogPanel />);
		const trigger = el.querySelector<HTMLButtonElement>(".showcase__ops-trigger")!;
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		// 收起时不渲染 JSON 内容。
		expect(el.querySelector('[data-testid="fixture-operations"]')).toBeNull();

		await click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const pre = el.querySelector<HTMLPreElement>('[data-testid="fixture-operations"]')!;
		expect(pre).not.toBeNull();
		expect(pre.getAttribute("data-count")).toBe("0");
	});

	it("trigger 为可键盘激活的 native button（Enter/Space 由浏览器合成 click）", async () => {
		const el = await mount(<OperationLogPanel />);
		const trigger = el.querySelector<HTMLButtonElement>(".showcase__ops-trigger")!;
		// native button 是 Enter/Space 可激活的前提（jsdom 不实现默认激活，故此处断言语义并用 click 驱动）。
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("type")).not.toBe("submit");
		await press(trigger, "Enter"); // 不应抛错，真实浏览器由默认动作触发 click。
		await click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		await click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("收起期间产生新事件只更新计数，不展开也不抢焦点", async () => {
		const el = await mount(
			<>
				<OperationLogPanel />
				<button type="button" data-testid="focus-anchor">
					anchor
				</button>
			</>,
		);
		const trigger = el.querySelector<HTMLButtonElement>(".showcase__ops-trigger")!;
		const anchor = el.querySelector<HTMLButtonElement>('[data-testid="focus-anchor"]')!;
		anchor.focus();
		expect(document.activeElement).toBe(anchor);

		await act(async () => {
			recordOperation(OPERATIONS.RUN, { runId: "r-1" });
		});

		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(el.querySelector('[data-testid="fixture-operations"]')).toBeNull();
		expect(el.querySelector('[data-testid="fixture-operations-count"]')?.textContent).toContain("1 条");
		expect(document.activeElement).toBe(anchor);
	});

	it("展开后记录的事件在 JSON 中可见且 limit 生效", async () => {
		const el = await mount(<OperationLogPanel limit={1} />);
		for (let index = 0; index < 3; index += 1) {
			await act(async () => {
				recordOperation(OPERATIONS.RUN, { runId: `r-${index}` });
			});
		}
		await click(el.querySelector(".showcase__ops-trigger"));
		const pre = el.querySelector<HTMLPreElement>('[data-testid="fixture-operations"]')!;
		const parsed = JSON.parse(pre.textContent ?? "[]") as Array<{ payload: { runId: string } }>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.payload.runId).toBe("r-2");
		expect(operationEntries()).toHaveLength(3);
	});
});

describe("scoped fixed-surface containment（读 CSS）", () => {
	it("仅以 .showcase__panel-box 为祖先把生产 dock 收拢为舞台内 absolute", () => {
		const rule = SHOWCASE_CSS.match(/\.showcase__panel-box > \.node-execution-dock\s*\{[^}]*\}/)?.[0] ?? "";
		expect(rule).toContain("position: absolute");
		expect(rule).toContain("bottom: 16px");
		expect(rule).toContain("translateX(-50%)");
	});

	it("diagnostics 内容有界滚动并安全换行", () => {
		const rule = SHOWCASE_CSS.match(/\.showcase__ops-pre\s*\{[^}]*\}/)?.[0] ?? "";
		expect(rule).toContain("max-height");
		expect(rule).toContain("overflow: auto");
		expect(rule).toContain("word-break");
	});

	it("工具型背景：不使用渐变/hero 装饰", () => {
		expect(SHOWCASE_CSS).not.toMatch(/linear-gradient\([^)]*(?:to right|135deg|120deg)/);
	});
});

describe("自有侧栏导航树", () => {
	const META = {
		stories: {
			"画布组件--执行面板--生产组合--图片-·-生产组合": {
				name: "图片 · 生产组合",
				levels: ["画布组件", "执行面板", "生产组合"],
			},
			"画布组件--弹窗--基础--标准-md": {
				name: "标准 md",
				levels: ["画布组件", "弹窗", "基础"],
			},
		},
	};

	it("从 meta.json 渲染分组与叶子，当前 story 高亮", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => META })) as unknown as typeof fetch,
		);
		const el = await mount(
			<ShowcaseSidebar currentStory="画布组件--弹窗--基础--标准-md" />,
		);
		await act(async () => {});
		expect(el.querySelector(".showcase__sidebar")).not.toBeNull();
		// 当前路径自动展开：只有「标准 md」这一支可见并高亮。
		const active = el.querySelector(".showcase__tree-item[data-active]");
		expect(active?.textContent).toContain("标准 md");
		expect(active?.getAttribute("aria-current")).toBe("page");
		expect(el.querySelector(".showcase__tree-item")?.textContent).toBe("标准 md");

		// 非当前分支默认折叠；展开后出现对应叶子。
		const panelTrigger = [...el.querySelectorAll<HTMLButtonElement>(".showcase__tree-trigger")].find(
			(trigger) => trigger.textContent?.includes("执行面板"),
		);
		expect(panelTrigger).not.toBeUndefined();
		await click(panelTrigger ?? null);
		await click(
			[...el.querySelectorAll<HTMLButtonElement>(".showcase__tree-trigger")].find((trigger) =>
				trigger.textContent?.includes("生产组合"),
			) ?? null,
		);
		expect(
			[...el.querySelectorAll(".showcase__tree-item")].map((leaf) => leaf.textContent),
		).toContain("图片 · 生产组合");
		vi.unstubAllGlobals();
	});

	it("搜索过滤并按名称收敛叶子", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => META })) as unknown as typeof fetch,
		);
		const el = await mount(<ShowcaseSidebar currentStory={null} />);
		await act(async () => {});
		const input = el.querySelector<HTMLInputElement>(".showcase__search-input")!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "弹窗");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const leaves = [...el.querySelectorAll(".showcase__tree-item")].map((leaf) => leaf.textContent);
		expect(leaves).toEqual(["标准 md"]);
		vi.unstubAllGlobals();
	});

	it("meta.json 加载失败显示可诊断状态", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
		);
		const el = await mount(<ShowcaseSidebar currentStory={null} />);
		await act(async () => {});
		expect(el.querySelector('[role="alert"]')?.textContent).toContain("meta.json");
		vi.unstubAllGlobals();
	});
});

describe("生产 UI 依赖所有权", () => {
	it("Radix / Lucide 由生产 Frontend 声明，Showcase 不再直接声明", () => {
		const showcaseDeps = { ...SHOWCASE_PACKAGE.dependencies, ...SHOWCASE_PACKAGE.devDependencies };
		for (const name of [
			"@radix-ui/react-toggle-group",
			"@radix-ui/react-collapsible",
			"@radix-ui/react-tooltip",
			"lucide-react",
		]) {
			expect(showcaseDeps[name], `${name} 不应再由 Showcase 直接声明`).toBeFalsy();
		}
		// 生产 Frontend 拥有这些依赖（见 frontend/package.json）。
		const frontendPackage = JSON.parse(
			readFileSync(path.join(HERE, "..", "..", "frontend", "package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(frontendPackage.dependencies?.["@radix-ui/react-tooltip"]).toBeTruthy();
		expect(frontendPackage.dependencies?.["@radix-ui/react-collapsible"]).toBeTruthy();
		expect(frontendPackage.dependencies?.["@radix-ui/react-toggle-group"]).toBeTruthy();
		expect(frontendPackage.dependencies?.["lucide-react"]).toBeTruthy();
	});

	it("Showcase 源码不直接 import Radix/Lucide（统一走生产公共入口）", () => {
		const offenders: string[] = [];
		for (const file of productionSources(path.join(HERE))) {
			const source = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^[ \t]*\/\/.*$/gm, "");
			if (/from\s+["']@radix-ui\//.test(source) || /from\s+["']lucide-react["']/.test(source)) {
				offenders.push(path.relative(HERE, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});

/** 递归列出 Showcase 生产源码（排除测试与 node_modules）。 */
function productionSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", "dist", "e2e", "public"].includes(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...productionSources(full));
		else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
	}
	return out;
}
