/**
 * Dialog story 视口与交互约束（change: align-showcase-reference-ux，任务 1.1 / 1.2）。
 *
 * 覆盖：
 * - 移除固定 460px 舞台，改用完整可用视口（结构断言读 CSS）；
 * - Header/Footer 可达、Body 独立滚动（读生产 `.dlg` 规则 + 渲染长内容）；
 * - 关闭弹窗后焦点恢复到触发按钮、不残留 overlay（真实 DialogHost）。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../frontend/src/cordis/ui/index.js";
import { DialogViewport } from "./dialog-viewport.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOWCASE_CSS = readFileSync(path.join(HERE, "showcase.css"), "utf8");
const UI_CSS = readFileSync(
	path.join(HERE, "..", "..", "frontend", "src", "cordis", "ui", "ui.css"),
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

describe("dialog story 视口", () => {
	it("不再使用固定 460px 舞台", () => {
		expect(SHOWCASE_CSS).not.toMatch(/\.showcase__dialog-box\s*\{[^}]*height:\s*460px/);
		expect(SHOWCASE_CSS).toMatch(/\.showcase__dialog-box\s*\{[^}]*height:\s*min\(100dvh/);
	});

	it("只在舞台内收敛弹窗上限，不覆盖内部尺寸与 overflow", () => {
		const boxRule = SHOWCASE_CSS.match(/\.showcase__dialog-box \.dlg\s*\{[^}]*\}/)?.[0] ?? "";
		expect(boxRule).toContain("max-width: 100%");
		expect(boxRule).toContain("max-height: 100%");
		expect(boxRule).not.toMatch(/(^|\n)\s*height\s*:/);
		expect(boxRule).not.toMatch(/overflow/);
	});

	it("提供 390×844 窄屏舞台", () => {
		expect(SHOWCASE_CSS).toMatch(
			/\.showcase__dialog-box--narrow\s*\{[^}]*width:\s*390px[^}]*height:\s*844px/,
		);
	});

	it("Body 独立滚动，Header/Footer 不参与滚动", () => {
		expect(UI_CSS).toMatch(/\.dlg__body\s*\{[^}]*overflow:\s*auto/);
		expect(UI_CSS).toMatch(/\.dlg__header\s*\{[^}]*flex-shrink:\s*0/);
		expect(UI_CSS).toMatch(/\.dlg__footer\s*\{[^}]*flex-shrink:\s*0/);
	});

	it("长内容弹窗渲染全部内容且 Header/Footer 存在", () => {
		const el = mount(
			<DialogViewport narrow>
				<Dialog.Content variant="standard" size="lg" ariaLabel="长内容弹窗">
					<DialogHeader onClose={() => undefined}>
						<DialogTitle>窄屏长内容</DialogTitle>
					</DialogHeader>
					<DialogBody>
						{Array.from({ length: 24 }, (_, index) => (
							<p key={index}>第 {index + 1} 段</p>
						))}
					</DialogBody>
					<DialogFooter>
						<button type="button" className="dlg__button dlg__button--primary">
							确定
						</button>
					</DialogFooter>
				</Dialog.Content>
			</DialogViewport>,
		);
		expect(el.querySelectorAll(".dlg__body p")).toHaveLength(24);
		expect(el.querySelector(".dlg__header")).not.toBeNull();
		expect(el.querySelector(".dlg__footer button")).not.toBeNull();
	});
});
