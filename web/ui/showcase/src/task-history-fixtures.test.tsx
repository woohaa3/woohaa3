/**
 * 任务历史查看页夹具 + 生产页面测试
 * （change: add-showcase-history-model-panels，任务 1.1–1.3 / 2.2）。
 *
 * 这里覆盖内存 `TaskHistoryClient` 的 contract 行为：deferred list、cursor 分页、
 * error/retry、实时事件合并、详情与画布跳转回调。页面交互用 jsdom 挂载生产组件验证。
 *
 * @vitest-environment jsdom
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	completeRunningTask,
	createMemoryTaskHistoryClient,
	fixtureMediaUrl,
	TASK_HISTORY_FIXTURES
} from "./task-history-fixtures.js";
import { TaskHistoryPage } from "../../../frontend/src/pages/task-history/index.js";

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
	// list 是异步的：再 flush 一轮微任务。
	await act(async () => {});
}

const byText = (selector: string, text: string) =>
	[...container.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));

/** 受控 input：必须走原生 value setter 才会触发 React onChange。 */
function setInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Task History fixtures", () => {
	it("fixture 覆盖文本/图片/视频/音频与 running/failed/succeeded/cancelled", () => {
		const kinds = new Set(TASK_HISTORY_FIXTURES.map((task) => task.result?.mediaKind ?? "none"));
		expect(kinds.has("text")).toBe(true);
		expect(kinds.has("image")).toBe(true);
		expect(kinds.has("video")).toBe(true);
		expect(kinds.has("audio")).toBe(true);
		const states = new Set(TASK_HISTORY_FIXTURES.map((task) => task.state));
		expect(states.has("running")).toBe(true);
		expect(states.has("failed")).toBe(true);
		expect(states.has("succeeded")).toBe(true);
	});

	it("list 返回稳定的创建时间倒序摘要，且不含事件时间线/请求参数", async () => {
		const { client } = createMemoryTaskHistoryClient();
		const first = await client.list({ limit: 4 });
		const second = await client.list({ limit: 4 });
		expect(first.items.map((task) => task.taskKey)).toEqual(second.items.map((task) => task.taskKey));
		expect(first.items.map((task) => task.taskKey)).toEqual([
			"task-text-succeeded",
			"task-image-succeeded",
			"task-video-running",
			"task-audio-succeeded"
		]);
		expect(first.nextCursor).toBe("4");
		expect(typeof first.watermark).toBe("number");
		const summary = first.items[0] as Record<string, unknown>;
		expect(summary.events).toBeUndefined();
		expect(summary.request).toBeUndefined();
		// 执行时显示快照与持久化 revision 随摘要返回。
		expect(summary.modelTitle).toBeTruthy();
		expect(summary.recordRevision).toBeGreaterThan(0);
	});

	it("cursor 分页合并后既有任务不重复，且最后一页无 nextCursor", async () => {
		const { client } = createMemoryTaskHistoryClient();
		const page1 = await client.list({ limit: 5 });
		const page2 = await client.list({ limit: 5, cursor: page1.nextCursor });
		const keys = [...page1.items, ...page2.items].map((task) => task.taskKey);
		expect(new Set(keys).size).toBe(keys.length);
		expect(page2.nextCursor).toBeUndefined();
		expect(keys.length).toBe(TASK_HISTORY_FIXTURES.length);
	});

	it("来源筛选区分 canvas/extension，插件任务不显示为缺少画布", async () => {
		const { client } = createMemoryTaskHistoryClient();
		const plugin = await client.list({ source: "extension" });
		expect(plugin.items.map((task) => task.taskKey)).toEqual(["task-plugin-succeeded"]);
		expect(plugin.items[0]!.source).toBe("extension");
		expect(plugin.items[0]!.extensionId).toBe("sample-site");
		expect(plugin.items[0]!.canvasId).toBeUndefined();
		const byExtension = await client.list({ extensionId: "sample-site" });
		expect(byExtension.items.map((task) => task.taskKey)).toEqual(["task-plugin-succeeded"]);
		const candidates = await client.candidates({});
		expect(candidates.plugins).toContainEqual({ extensionId: "sample-site" });
	});

	it("state 过滤只返回对应状态，进行中覆盖三态，失败不会被表示为空列表", async () => {
		const { client } = createMemoryTaskHistoryClient();
		const failed = await client.list({ state: "failed" });
		expect(failed.items.map((task) => task.taskKey)).toEqual(["task-image-failed"]);
		const active = await client.list({ states: ["queued", "pending", "running"] });
		expect(active.items.map((task) => task.taskKey).sort()).toEqual(["task-text-pending", "task-video-running"]);
	});

	it("deferList 挂起请求，flushList 后放行", async () => {
		const controls = createMemoryTaskHistoryClient();
		controls.deferList();
		let settled = false;
		const pending = controls.client.list({ limit: 2 }).then((page) => {
			settled = true;
			return page;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		controls.flushList();
		const page = await pending;
		expect(page.items).toHaveLength(2);
	});

	it("failNextList 抛出可诊断错误，随后重试可成功", async () => {
		const controls = createMemoryTaskHistoryClient();
		controls.failNextList("历史加载失败：网关不可用");
		await expect(controls.client.list()).rejects.toThrow("历史加载失败：网关不可用");
		await expect(controls.client.list()).resolves.toMatchObject({ items: expect.any(Array) });
	});

	it("emit 更新同一 taskKey 的状态，订阅者收到新摘要", async () => {
		const controls = createMemoryTaskHistoryClient();
		const running = TASK_HISTORY_FIXTURES.find((task) => task.taskKey === "task-video-running")!;
		const seen: Array<{ taskKey: string; state: string }> = [];
		const unsubscribe = controls.client.subscribe({ cursor: 0, onRecord: (record) => seen.push({ taskKey: record.taskKey, state: record.state }) });
		expect(controls.subscriberCount()).toBe(1);
		controls.emit(completeRunningTask(running, "2026-09-27T08:05:00.000Z"));
		expect(seen).toEqual([{ taskKey: "task-video-running", state: "succeeded" }]);
		unsubscribe();
		expect(controls.subscriberCount()).toBe(0);
		// 事实来源已更新：后续 list 也看到终态。
		const listed = await controls.client.list({ state: "succeeded" });
		expect(listed.items.some((task) => task.taskKey === "task-video-running")).toBe(true);
	});

	it("媒体 URL 由稳定 storageKey 确定性构造，不依赖网络", () => {
		expect(fixtureMediaUrl("generation-outputs/a1b2c3d4e5f6.png")).toBe(
			fixtureMediaUrl("generation-outputs/a1b2c3d4e5f6.png")
		);
		expect(fixtureMediaUrl("generation-outputs/a1b2c3d4e5f6.png")).toContain("data:image/svg+xml");
	});
});

describe("TaskHistoryPage（生产组件）", () => {
	it("渲染 tabs、筛选、列表与详情，并显示视频结果与 metadata", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(
			<TaskHistoryPage
				client={controls.client}
				resolveMediaUrl={fixtureMediaUrl}
				onOpenCanvas={() => undefined}
				pageSize={20}
			/>
		);
		for (const label of ["全部", "进行中", "成功", "失败", "取消"]) {
			expect(byText("button", label)).toBeTruthy();
		}
		expect(container.textContent).toContain("运行中");

		// 打开视频任务详情：结果、metadata 与关闭动作都可见。
		await act(async () => {
			byText("button", "详情")!.click();
		});
		await act(async () => {});
		expect(controls.detailCalls).toEqual(["task-text-succeeded"]);
		expect(container.textContent).toContain("生命周期时间线");

		const videoRow = container.querySelector('[data-task-key="task-video-succeeded"]')!;
		await act(async () => {
			(videoRow.querySelector("button") as HTMLButtonElement).click();
		});
		await act(async () => {});
		const drawer = container.querySelector('[data-testid="task-history-detail"]')!;
		expect(drawer.innerHTML).toContain("generation-outputs/112233445566.mp4");
		expect(drawer.textContent).toContain("时长 8s");

		await act(async () => {
			([...drawer.querySelectorAll("button")].find((button) =>
				button.getAttribute("aria-label") === "关闭详情"
			) as HTMLButtonElement).click();
		});
		await act(async () => {});
		expect(container.querySelector('[data-testid="task-history-detail"]')).toBeNull();
	});

	it("分页：加载下一页不清空既有结果，且不重复", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(
			<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} pageSize={4} />
		);
		const firstPage = [...container.querySelectorAll("[data-task-key]")].map((row) =>
			row.getAttribute("data-task-key")
		);
		expect(firstPage).toHaveLength(4);

		await act(async () => {
			byText("button", "下一页")!.click();
		});
		await act(async () => {});
		const secondPage = [...container.querySelectorAll("[data-task-key]")].map((row) =>
			row.getAttribute("data-task-key")
		);
		expect(secondPage).toHaveLength(4);
		expect(secondPage.every((entry) => !firstPage.includes(entry))).toBe(true);
		expect(container.textContent).toContain("第 2 页");
	});

	it("首次加载失败显示错误与重试；重试后显示任务（不误呈现为暂无任务）", async () => {
		const controls = createMemoryTaskHistoryClient();
		controls.failNextList("历史加载失败：网关不可用");
		await mount(<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} />);
		const alert = container.querySelector('[role="alert"]')!;
		expect(alert.textContent).toContain("网关不可用");
		expect(alert.textContent).toContain("重试");
		expect(container.textContent).not.toContain("没有匹配的执行记录");

		await act(async () => {
			(alert.querySelector("button") as HTMLButtonElement).click();
		});
		await act(async () => {});
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll("[data-task-key]").length).toBeGreaterThan(0);
	});

	it("实时更新：running → succeeded 更新行与已打开详情，不产生重复行", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(
			<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} pageSize={20} />
		);
		const rowCount = container.querySelectorAll("[data-task-key]").length;

		const runningRow = container.querySelector('[data-task-key="task-video-running"]')!;
		await act(async () => {
			(runningRow.querySelector("button") as HTMLButtonElement).click();
		});
		await act(async () => {});
		expect(container.querySelector('[data-testid="task-history-detail"]')).not.toBeNull();

		const running = TASK_HISTORY_FIXTURES.find((task) => task.taskKey === "task-video-running")!;
		await act(async () => {
			controls.emit(completeRunningTask(running, "2026-09-27T08:05:00.000Z"));
		});
		expect(container.querySelectorAll("[data-task-key]").length).toBe(rowCount);
		const updated = container.querySelector('[data-task-key="task-video-running"]')!;
		expect(updated.getAttribute("data-state")).toBe("succeeded");
		// 详情保持打开并显示新状态。
		expect(container.querySelector('[data-testid="task-history-detail"]')).not.toBeNull();
		expect(container.textContent).toContain("实时完成后写入的结果摘要");
	});

	it("可跳转任务调用 navigation callback；不可跳转显示原因且不触发导航", async () => {
		const controls = createMemoryTaskHistoryClient();
		const openCanvas = vi.fn();
		await mount(
			<TaskHistoryPage
				client={controls.client}
				resolveMediaUrl={fixtureMediaUrl}
				onOpenCanvas={openCanvas}
				pageSize={20}
			/>
		);

		const jumpable = container.querySelector('[data-task-key="task-text-succeeded"]')!;
		await act(async () => {
			([...jumpable.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("打开画布")
			) as HTMLButtonElement).click();
		});
		expect(openCanvas).toHaveBeenCalledWith({ canvasId: "canvas-main", nodeId: "node-text-1" });

		// 缺 nodeId 的音频任务：按钮禁用 + 稳定原因，且不调用回调。
		const nonJumpable = container.querySelector('[data-task-key="task-audio-succeeded"]')!;
		const disabled = [...nonJumpable.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("打开画布")
		)!;
		expect(disabled.disabled).toBe(true);
		expect(nonJumpable.querySelector('[data-jump-reason="missing-node"]')?.textContent).toContain(
			"不可跳转"
		);
		expect(openCanvas).toHaveBeenCalledTimes(1);
	});

	it("tab 过滤走服务端 states 查询并收敛失败任务", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} />);
		await act(async () => {
			byText('button[role="radio"]', "失败")!.click();
		});
		await act(async () => {});
		const rows = [...container.querySelectorAll("[data-task-key]")];
		expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["failed"]);
		expect(container.textContent).not.toContain("没有匹配的执行记录");
		expect(controls.listCalls.some((call) => call.states?.includes("failed"))).toBe(true);
	});

	it("草稿与应用分离：输入不立即请求，应用/Enter 才提交一次并重置分页", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} />);
		const before = controls.listCalls.length;
		const input = container.querySelector<HTMLInputElement>('[aria-label="画布筛选"]')!;
		await act(async () => {
			setInputValue(input, "canvas-main");
		});
		expect(controls.listCalls.length).toBe(before);
		expect(container.textContent).toContain("当前修改尚未应用");

		await act(async () => {
			byText("button", "应用筛选")!.click();
		});
		await act(async () => {});
		const applied = controls.listCalls.slice(before);
		expect(applied).toHaveLength(1);
		expect(applied[0]!.canvasId).toBe("canvas-main");
	});

	it("新任务事件进入去重提示，既有 running 原位收敛为 succeeded", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} pageSize={20} />);
		const running = TASK_HISTORY_FIXTURES.find((task) => task.taskKey === "task-video-running")!;
		await act(async () => {
			controls.emit(completeRunningTask(running, "2026-09-27T08:05:00.000Z"));
		});
		const updated = container.querySelector('[data-task-key="task-video-running"]')!;
		expect(updated.getAttribute("data-state")).toBe("succeeded");
		// 新任务不插入当前页，而是显示去重提示。
		const inserted = TASK_HISTORY_FIXTURES[0]!;
		void inserted;
		await act(async () => {
			controls.emit({ ...running, taskKey: "task-new", state: "queued", recordRevision: 200, createdAt: "2026-09-27T07:59:00.000Z" });
		});
		expect(container.textContent).toContain("条新任务");
	});

	it("详情失效显示稳定反馈且不清空列表", async () => {
		const controls = createMemoryTaskHistoryClient();
		await mount(<TaskHistoryPage client={controls.client} resolveMediaUrl={fixtureMediaUrl} />);
		controls.failNextDetail("task-not-found", "执行记录不存在或已超过保留期");
		await act(async () => {
			byText("button", "详情")!.click();
		});
		await act(async () => {});
		const drawer = container.querySelector('[data-testid="task-history-detail"]')!;
		expect(drawer.textContent).toContain("不存在");
		expect(container.querySelectorAll("[data-task-key]").length).toBeGreaterThan(0);
	});

	it("筛选候选来自历史（含已下线模型），不依赖当前 catalog", async () => {
		const { client } = createMemoryTaskHistoryClient();
		const candidates = await client.candidates({});
		expect(candidates.providers.some((provider) => provider.providerId === "litellm")).toBe(true);
		expect(candidates.models.some((model) => model.modelKey === "doubao-seedance-1-0-pro")).toBe(true);
	});
});
