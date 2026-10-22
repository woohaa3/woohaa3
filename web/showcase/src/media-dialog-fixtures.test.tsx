/**
 * 节点媒体 Dialog 查看页验收
 * （change: 2026-09-29-align-node-media-dialogs，任务 4.1）。
 *
 * 断言 story 直接渲染**生产**图片预览与视频截帧组件：共享媒体工作区结构、SVG 图标控件、
 * 状态不改变外框；fixture 不复制生产 markup、不访问真实服务。
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
	CAPTURED_FRAMES_STORY,
	PARTIAL_FAILURE_STORY,
} from "./video-dialog-fixtures.js";
import {
	MEDIA_IMAGE_READY,
	MEDIA_IMAGE_UNAVAILABLE,
	MediaImageStory,
} from "./media-dialog-fixtures.js";
import { FrameCaptureStory } from "./video-dialog-fixtures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_FIXTURE = readFileSync(path.join(HERE, "media-dialog-fixtures.tsx"), "utf8");
const VIDEO_FIXTURE = readFileSync(path.join(HERE, "video-dialog-fixtures.tsx"), "utf8");
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

describe("媒体工作区 fixture 边界", () => {
	it("直接渲染生产组件，不复制 markup、不访问真实服务", () => {
		expect(MEDIA_FIXTURE).toContain("MediaDialog");
		expect(VIDEO_FIXTURE).toContain("createFrameCaptureRenderer");
		// fixture 不通过 fetch/上传/Canvas 服务绕过生产 renderer。
		for (const [name, source] of [["media", MEDIA_FIXTURE], ["video", VIDEO_FIXTURE]] as const) {
			expect(source, name).not.toMatch(/\bfetch\(/);
			expect(source, name).not.toContain("XMLHttpRequest");
		}
	});

	it("媒体工作区 CSS 只消费语义 token，stage 使用 media token", () => {
		// chrome 区域不得出现业务私有 palette。
		const start = UI_CSS.indexOf(".dlg__body--media-workspace");
		const end = UI_CSS.indexOf(".dlg__section", start);
		const workspace = UI_CSS.slice(start, end);
		expect(workspace.length).toBeGreaterThan(0);
		expect(workspace).not.toContain("--mc-");
		expect(workspace).toContain("var(--app-web-border)");
		expect(workspace).toContain("var(--app-media-dialog-surface)");
		expect(workspace).toContain("var(--app-interaction-focus)");
	});
});

describe("图片预览 story（任务 2.1/2.3）", () => {
	it("ready 状态渲染共享工作区、中性舞台与图标控件", () => {
		const el = mount(<MediaImageStory fixture={MEDIA_IMAGE_READY} />);
		expect(el.querySelector(".dlg__media-workspace")).not.toBeNull();
		expect(el.querySelector(".dlg__media-main")).not.toBeNull();
		expect(el.querySelector(".dlg__stage--image")).not.toBeNull();
		expect(el.querySelector("img")?.getAttribute("src")).toBe(MEDIA_IMAGE_READY.url);
		for (const name of ["缩小", "放大", "适应屏幕并重置", "关闭"]) {
			const button = el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
			expect(button, name).not.toBeNull();
			expect(button!.querySelector("svg"), name).not.toBeNull();
		}
	});

	it("unavailable 状态显示原因且仍可关闭", () => {
		const el = mount(<MediaImageStory fixture={MEDIA_IMAGE_UNAVAILABLE} />);
		expect(el.querySelector("img")).toBeNull();
		expect(el.querySelector('[role="alert"]')?.textContent).toContain("不可预览");
		expect(el.querySelector('button[aria-label="关闭"]')).not.toBeNull();
	});
});

describe("视频截帧 story（任务 3.2/3.3）", () => {
	it("已有帧状态渲染主媒体区、辅助帧区与 Footer 提交动作", () => {
		const el = mount(<FrameCaptureStory seed={CAPTURED_FRAMES_STORY} title="视频截帧 · 已有帧" />);
		expect(el.querySelector(".dlg__media-workspace--split")).not.toBeNull();
		expect(el.querySelector(".dlg__media-main")).not.toBeNull();
		expect(el.querySelector(".dlg__media-aside .video-frame-dialog__frames")).not.toBeNull();
		expect(el.querySelector(".dlg__footer")?.textContent).toContain("添加选中帧");
	});

	it("部分失败状态显示逐项错误与只重试失败项", () => {
		const el = mount(<FrameCaptureStory seed={PARTIAL_FAILURE_STORY} title="视频截帧 · 部分失败" />);
		expect(el.textContent).toContain("上传失败，请重试");
		expect(el.querySelector(".dlg__footer")?.textContent).toContain("重试失败项");
		// 不再出现字体字符控件。
		for (const glyph of ["▶", "❚❚", "🔇", "🔊", "✕"]) {
			expect(el.textContent, glyph).not.toContain(glyph);
		}
	});
});
