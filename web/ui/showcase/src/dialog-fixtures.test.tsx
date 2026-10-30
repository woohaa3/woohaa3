import { UiProvider } from "@woohaa3/ui/primitives";
/**
 * Dialog 焦点恢复交互（change: align-showcase-reference-ux，任务 1.2）。
 *
 * 用生产的 `DialogService` + `DialogHost` + 单图替换确认 renderer，验证：
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
	createReplaceConfirmRenderer,
	PASTE_REPLACE_DIALOG_ID,
	replaceConfirmDefinition,
} from "../../../frontend/src/cordis/ui/index";
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
	const registrations = useMemo<ShowcaseDialogRegistration[]>(
		() => [
			{
				dialogId: PASTE_REPLACE_DIALOG_ID,
				definition: replaceConfirmDefinition,
				renderer: createReplaceConfirmRenderer(async () => ({ ok: true })),
			},
		],
		[],
	);
	return (
		<DialogHostStage
			registrations={registrations}
			dialogId={PASTE_REPLACE_DIALOG_ID}
			payload={{ intentId: "intent-1", fileName: "screenshot.png", nodeLabel: "主视觉图" }}
			triggerLabel="打开替换确认"
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
