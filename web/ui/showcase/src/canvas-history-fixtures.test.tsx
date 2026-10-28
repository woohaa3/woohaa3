/**
 * 画布「全部生成历史」弹窗夹具 + 生产组件测试
 * （change: add-canvas-generation-history-dialog）。
 *
 * 覆盖内存 `CanvasHistoryClient` 的 contract 行为：cursor 分页、种类筛选、error/retry，
 * 以及 jsdom 挂载生产 `CanvasHistoryBrowser` 的交互与只读断言。
 *
 * @vitest-environment jsdom
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	CANVAS_HISTORY_FIXTURES,
	createMemoryCanvasHistoryClient,
	useShowcaseCanvasHistoryController
} from "./canvas-history-fixtures.js";
import { CanvasHistoryBrowser } from "../../../frontend/src/cordis/plugins/node-history/canvas-history-browser.js";

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
	await act(async () => {});
}

describe("Canvas History fixtures", () => {
	it("fixture 覆盖五类内容且至少一条当前标记", () => {
		const kinds = new Set(CANVAS_HISTORY_FIXTURES.map((item) => item.kind));
		expect([...kinds].sort()).toEqual(["audio", "image", "model", "text", "video"]);
		expect(CANVAS_HISTORY_FIXTURES.some((item) => item.current)).toBe(true);
		// 预览引用是确定性 data URL，不产生网络请求。
		const image = CANVAS_HISTORY_FIXTURES.find((item) => item.kind === "image")!;
		expect(image.preview.kind === "image" && image.preview.href.startsWith("data:image/svg+xml")).toBe(true);
	});

	it("内存 client：cursor 分页与种类筛选，计数反映全部历史", async () => {
		const controls = createMemoryCanvasHistoryClient({ pageSize: 2 });
		await controls.controller.open({ canvasId: "c1" });
		let state = controls.controller.getState()!;
		expect(state.items).toHaveLength(2);
		expect(state.nextCursor).toBe("2");
		expect(state.kindCounts.model).toBe(1);

		await controls.controller.loadMore();
		state = controls.controller.getState()!;
		expect(state.items).toHaveLength(4);

		await controls.controller.setFilter("text");
		state = controls.controller.getState()!;
		expect(state.items.every((item) => item.kind === "text")).toBe(true);
		expect(state.kindCounts.image).toBe(1);
		expect(controls.calls.at(-1)?.kind).toBe("text");
	});

	it("内存 client：失败后可重试", async () => {
		const controls = createMemoryCanvasHistoryClient({ failInitial: "网关不可用" });
		await controls.controller.open({ canvasId: "c1" });
		expect(controls.controller.getState()).toMatchObject({ status: "error", error: "网关不可用" });
		await controls.controller.retry();
		expect(controls.controller.getState()).toMatchObject({ status: "ready" });
	});

	it("挂载生产组件：筛选切换、选中详情与只读", async () => {
		const controls = createMemoryCanvasHistoryClient();
		await controls.controller.open({ canvasId: "c1" });
		await mount(<CanvasHistoryBrowser controller={controls.controller} onClose={() => undefined} />);

		const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((node) =>
			node.textContent?.includes("图片")
		);
		expect(tab).toBeDefined();
		await act(async () => {
			tab!.click();
		});
		expect(container.querySelector('[data-preview-kind="image"]')).not.toBeNull();
		// 只读：不出现恢复/添加动作。
		expect(container.textContent).not.toContain("设为当前");
		expect(container.textContent).not.toContain("添加到画布");
	});

	it("稳定钩子：useShowcaseCanvasHistoryController 返回实现 contract 的 client", async () => {
		let captured: ReturnType<typeof useShowcaseCanvasHistoryController> | null = null;
		function Probe() {
			captured = useShowcaseCanvasHistoryController();
			return null;
		}
		await mount(<Probe />);
		expect(captured!.controller.getState()).toBeNull();
		await act(async () => {
			await captured!.controller.open({ canvasId: "c1" });
		});
		expect(captured!.controller.getState()!.items.length).toBeGreaterThan(0);
	});
});
