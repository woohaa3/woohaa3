import { UiProvider } from "@woohaa3/ui/primitives";
/**
 * Dialog 焦点恢复交互（change: align-showcase-reference-ux，任务 1.2）。
 *
 * 用生产的 `DialogService` + `DialogHost` + 片段库 renderer，验证：
 * - 打开后焦点进入弹窗；
 * - 关闭后焦点回到原触发按钮；
 * - 舞台不残留拦截输入的 overlay。
 *
 * @vitest-environment jsdom
 */
import { useMemo } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createLibraryRenderer,
	SNIPPET_LIBRARY_DIALOG_ID,
	snippetLibraryDefinition,
	useShowcaseCatalog,
} from "./snippet-fixtures.js";
import { DialogHostStage, type ShowcaseDialogRegistration } from "./dialog-fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.innerHTML = "";
});

function Harness() {
	const catalog = useShowcaseCatalog();
	const registrations = useMemo<ShowcaseDialogRegistration[]>(
		() => [
			{
				dialogId: SNIPPET_LIBRARY_DIALOG_ID,
				definition: snippetLibraryDefinition,
				renderer: createLibraryRenderer(catalog, {
					openEditor: () => undefined,
					requestDelete: () => undefined,
					requestDeleteTag: () => undefined,
				}),
			},
		],
		[catalog],
	);
	return (
		<DialogHostStage
			registrations={registrations}
			dialogId={SNIPPET_LIBRARY_DIALOG_ID}
			payload={{}}
			triggerLabel="打开片段库"
			caption="焦点恢复"
		/>
	);
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

describe("dialog 焦点恢复", () => {
	it("打开进入弹窗，关闭回到触发按钮且不残留 overlay", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root!.render(<UiProvider><Harness /></UiProvider>));
		await flush();

		const trigger = container.querySelector<HTMLButtonElement>('[data-testid="dialog-trigger"]');
		expect(trigger).not.toBeNull();
		trigger!.focus();
		expect(document.activeElement).toBe(trigger);

		act(() => trigger!.click());
		await flush();

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		// 焦点进入弹窗内部（首个可编辑控件或可聚焦控件）。
		expect(dialog!.contains(document.activeElement)).toBe(true);

		const close = document.querySelector<HTMLButtonElement>(".dlg__close");
		expect(close).not.toBeNull();
		act(() => close!.click());
		await flush();

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector(".dlg-host")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
