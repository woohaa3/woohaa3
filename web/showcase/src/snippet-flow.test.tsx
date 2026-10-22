/**
 * 片段库连续 flow 组件测试（change: align-showcase-reference-ux，任务 3.3 / 3.4）。
 *
 * 用生产 `DialogService` + `DialogHost` + 生产 renderer，覆盖：
 * - library → editor → save 后返回 library 且显示新内容；
 * - library → delete-confirm → 确认删除后条目消失、取消则不变；
 * - 复制成功/失败、保存失败、标签重命名失败的可见错误。
 *
 * @vitest-environment jsdom
 */
import { useEffect, useMemo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DialogHost,
	type DialogService,
} from "../../frontend/src/cordis/ui/index.js";
import {
	SNIPPET_EDITOR_DIALOG_ID,
	SNIPPET_LIBRARY_DIALOG_ID,
} from "@woohaa3/extension-prompt-snippets/frontend";
import {
	useSnippetDialogService,
	type CatalogEvent,
	type CatalogEventSink,
} from "./snippet-fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.innerHTML = "";
	delete (navigator as { clipboard?: unknown }).clipboard;
});

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await Promise.resolve();
	});
}

function dialogById(dialogId: string): Element | null {
	const layers = document.querySelectorAll('[data-dialog-instance]');
	for (const layer of layers) {
		if (layer.getAttribute("data-dialog-instance")?.includes(dialogId)) return layer;
	}
	return null;
}

function writeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function findMenuItem(label: string): HTMLElement | null {
	return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
		(node.textContent ?? "").trim().includes(label),
	) ?? null;
}

function clickMenuTrigger(button: HTMLButtonElement | null) {
	if (!button) return;
	act(() => {
		button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
		button.click();
	});
}

function findButton(el: ParentNode, label: string): HTMLButtonElement | null {
	return [...el.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		(button.textContent ?? "").trim().includes(label),
	) ?? null;
}

type HarnessOptions = {
	events?: CatalogEvent[];
	failList?: boolean;
	failCreate?: boolean;
	failUpdate?: boolean;
	failDelete?: boolean;
	failTagCreate?: boolean;
	failTagRename?: boolean;
	createDraft?: { name?: string; body?: string };
	/** 拿到生产 DialogService，便于测试从「保存为片段」入口打开 editor。 */
	onService?: (service: DialogService) => void;
};

function Harness(options: HarnessOptions) {
	const eventSink = useMemo<CatalogEventSink | undefined>(
		() => (options.events ? { push: (event) => options.events!.push(event) } : undefined),
		[options.events],
	);
	const { service } = useSnippetDialogService({ events: eventSink, ...options });
	useEffect(() => {
		options.onService?.(service);
	}, [options, service]);
	const [opened, setOpened] = useState(false);
	if (!opened) {
		service.open({ dialogId: SNIPPET_LIBRARY_DIALOG_ID, payload: {} });
		setOpened(true);
	}
	return <DialogHost dialogs={service} />;
}

function mount(options: HarnessOptions = {}) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root!.render(<Harness {...options} />));
	return container;
}

describe("片段库连续 flow", () => {
	it("library → editor → 保存后返回 library 并显示新片段", async () => {
		const events: CatalogEvent[] = [];
		let service: DialogService | null = null;
		const container = mount({
			events,
			createDraft: { name: "草稿名称", body: "草稿正文" },
			onService: (created) => {
				service = created;
			},
		});
		await flush();

		// 通过生产「保存为片段…」入口（带 nodeId）打开 editor，携带捕获草稿。
		act(() => {
			service!.open({
				dialogId: SNIPPET_EDITOR_DIALOG_ID,
				payload: { mode: "create", draftName: "草稿名称", draftBody: "草稿正文" },
			});
		});
		await flush();

		const dialog = dialogById("prompt-snippet-editor");
		expect(dialog).not.toBeNull();
		const nameInput = dialog!.querySelector<HTMLInputElement>('input[type="text"]');
		expect(nameInput).not.toBeNull();
		writeInput(nameInput!, "新的片段名称");
		await flush();

		const save = findButton(dialog!, "保存") as HTMLButtonElement;
		expect(save.disabled).toBe(false);
		act(() => save.click());
		await flush();

		// 回到 library 并显示新条目。
		expect(dialogById("prompt-snippet-editor")).toBeNull();
		expect(container.textContent).toContain("新的片段名称");
		expect(events.some((event) => event.type === "create" && event.name === "新的片段名称")).toBe(true);
	});

	it("保存失败保留 editor 草稿与错误", async () => {
		let service: DialogService | null = null;
		mount({
			failCreate: true,
			createDraft: { name: "会失败的片段", body: "正文" },
			onService: (created) => {
				service = created;
			},
		});
		await flush();

		act(() => {
			service!.open({
				dialogId: SNIPPET_EDITOR_DIALOG_ID,
				payload: { mode: "create", draftName: "会失败的片段", draftBody: "正文" },
			});
		});
		await flush();
		const dialog = dialogById("prompt-snippet-editor")!;
		expect(dialog).not.toBeNull();

		act(() => (findButton(dialog, "保存") as HTMLButtonElement).click());
		await flush();

		// editor 仍在，且显示错误，草稿保留。
		expect(dialogById("prompt-snippet-editor")).not.toBeNull();
		expect(document.body.textContent).toContain("保存失败（fixture）");
		expect(dialog.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("会失败的片段");
	});

	it("library → 删除确认 → 确认后条目消失", async () => {
		const events: CatalogEvent[] = [];
		const container = mount({ events });
		await flush();

		// 打开「我的夜景镜头」的更多菜单。
		const more = container.querySelector<HTMLButtonElement>('[aria-label="我的夜景镜头 更多操作"]');
		expect(more).not.toBeNull();
		clickMenuTrigger(more);
		await flush();
		const del = findMenuItem("删除");
		expect(del).not.toBeNull();
		act(() => del!.click());
		await flush();

		const deleteDialog = dialogById("prompt-snippet-delete-confirm");
		expect(deleteDialog).not.toBeNull();
		const confirm = findButton(deleteDialog!, "删除");
		act(() => confirm!.click());
		await flush();

		await flush();
		expect(container.textContent).not.toContain("我的夜景镜头");
		expect(events.some((event) => event.type === "delete" && event.snippetId === "psnip-custom")).toBe(true);
	});

	it("删除确认取消时目录不变", async () => {
		const events: CatalogEvent[] = [];
		const container = mount({ events });
		await flush();

		clickMenuTrigger(container.querySelector<HTMLButtonElement>('[aria-label="我的夜景镜头 更多操作"]'));
		await flush();
		act(() => findMenuItem("删除")!.click());
		await flush();

		const cancel = findButton(dialogById("prompt-snippet-delete-confirm")!, "取消");
		act(() => cancel!.click());
		await flush();

		expect(document.body.textContent).toContain("我的夜景镜头");
		expect(events.some((event) => event.type === "delete")).toBe(false);
	});

	it("无标签筛选更新结果数", async () => {
		const container = mount();
		await flush();

		const untagged = findButton(container, "无标签");
		expect(untagged).not.toBeNull();
		act(() => untagged!.click());
		await flush();

		expect(container.querySelector('[data-testid="library-results-meta"]')?.textContent).toContain("1 个结果");
		expect(document.body.textContent).toContain("临时草稿");
		expect(document.body.textContent).not.toContain("写实增强");
	});

	it("标签重命名与内置标签保护", async () => {
		const container = mount();
		await flush();

		// 切到标签视图。
		act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((tab) => tab.textContent?.includes("管理标签"))!.click());
		await flush();

		// 内置标签的重命名/删除按钮禁用。
		const builtInRow = [...container.querySelectorAll("li")].find((li) => li.textContent?.includes("分镜"));
		expect(builtInRow).toBeDefined();
		const buttons = [...builtInRow!.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons.every((button) => button.disabled)).toBe(true);
	});

	it("复制正文成功显示反馈，失败显示错误", async () => {		const container = mount();
		await flush();

		// 成功：stub clipboard。
		Object.assign(navigator, {
			clipboard: { writeText: async () => undefined },
		});
		clickMenuTrigger(container.querySelector<HTMLButtonElement>('[aria-label="我的夜景镜头 更多操作"]'));
		await flush();
		act(() => findMenuItem("复制正文")!.click());
		await flush();
		expect(container.textContent).toContain("已复制正文");

		// 失败：clipboard 抛错。
		Object.assign(navigator, {
			clipboard: { writeText: async () => { throw new Error("剪贴板被拒绝"); } },
		});
		clickMenuTrigger(container.querySelector<HTMLButtonElement>('[aria-label="写实增强 更多操作"]'));
		await flush();
		act(() => findMenuItem("复制正文")!.click());
		await flush();
		expect(container.textContent).toContain("剪贴板被拒绝");
	});

	it("查询失败显示错误与重试入口", async () => {
		const container = mount({ failList: true });
		await flush();
		expect(container.textContent).toContain("查询失败（fixture）");
		expect(findButton(container, "重试")).not.toBeNull();
	});

	it("自定义标签重命名成功并更新列表", async () => {
		const events: CatalogEvent[] = [];
		const container = mount({ events });
		await flush();

		const findCustomRow = () =>
			[...container.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes("写实"));
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
				.find((tab) => tab.textContent?.includes("管理标签"))!
				.click(),
		);
		await flush();

		act(() => (findButton(findCustomRow()!, "重命名") as HTMLButtonElement).click());
		await flush();

		const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="标签名称"]');
		expect(renameInput).not.toBeNull();
		writeInput(renameInput!, "写实风");
		const renamingRow = renameInput!.closest("li")!;
		act(() => (findButton(renamingRow, "保存") as HTMLButtonElement).click());
		await flush();

		expect(container.textContent).toContain("写实风");
		expect(events.some((event) => event.type === "tag-rename" && event.name === "写实风")).toBe(true);
	});

	it("标签重命名失败显示错误且保留编辑", async () => {
		const container = mount({ failTagRename: true });
		await flush();

		const findCustomRow = () =>
			[...container.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes("写实"));
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
				.find((tab) => tab.textContent?.includes("管理标签"))!
				.click(),
		);
		await flush();
		act(() => (findButton(findCustomRow()!, "重命名") as HTMLButtonElement).click());
		await flush();
		const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="标签名称"]')!;
		writeInput(renameInput, "写实风");
		const renamingRow = renameInput.closest("li")!;
		act(() => (findButton(renamingRow, "保存") as HTMLButtonElement).click());
		await flush();

		expect(container.textContent).toContain("标签重命名失败（fixture）");
		expect(container.querySelector<HTMLInputElement>('input[aria-label="标签名称"]')).not.toBeNull();
	});

	it("标签删除确认后列表与计数更新", async () => {
		const events: CatalogEvent[] = [];
		const container = mount({ events });
		await flush();

		const findCustomRow = () =>
			[...container.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes("写实"));
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
				.find((tab) => tab.textContent?.includes("管理标签"))!
				.click(),
		);
		await flush();
		act(() => (findButton(findCustomRow()!, "删除") as HTMLButtonElement).click());
		await flush();

		const deleteDialog = dialogById("prompt-snippet-tag-delete-confirm");
		expect(deleteDialog).not.toBeNull();
		act(() => (findButton(deleteDialog!, "删除") as HTMLButtonElement).click());
		await flush();

		expect(events.some((event) => event.type === "tag-delete")).toBe(true);
		expect(container.textContent).not.toContain("写实（2）");
	});

	it("编辑/返回后保留搜索与筛选上下文", async () => {
		const container = mount();
		await flush();

		// 设置搜索词与筛选。
		const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索片段"]')!;
		writeInput(search, "写实");
		await flush();
		act(() => (findButton(container, "无标签") as HTMLButtonElement).click());
		await flush();

		// 打开某个条目的编辑器再返回（用「编辑」入口需要自定义片段；这里用新建/取消）。
		act(() => (findButton(container, "新建片段") as HTMLButtonElement).click());
		await flush();
		const editor = dialogById("prompt-snippet-editor");
		expect(editor).not.toBeNull();
		act(() => (findButton(editor!, "取消") as HTMLButtonElement).click());
		await flush();

		// 搜索与筛选上下文保留（library 未重挂载）。
		expect(container.querySelector<HTMLInputElement>('input[aria-label="搜索片段"]')!.value).toBe("写实");
		expect(container.querySelector(".snippet-library__filter[data-state='on']")?.textContent).toContain("无标签");
	});
});
