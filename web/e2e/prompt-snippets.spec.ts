/**
 * 提示词片段库端到端验收（change: add-prompt-snippet-library，任务 7.1）。
 *
 * 对齐参考实现的产品形态：
 * - **保存**：节点右键菜单「保存为片段…」打开编辑器，名称/正文可见；
 * - **引用**：执行面板提示词输入框键入 `#` 触发片段候选并插入正文；
 * - 片段目录由 Canvas Service 独立存储，跨刷新保留。
 */
import { expect, test } from "@playwright/test";
import {
	installPageHelpers,
	readStoredCanvas,
	resetCanvasStorage,
	createNode,
	sendSelection,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

const DOCK = ".node-execution-dock";
const MENU = ".canvas-context-menu";
const ITEM = `${MENU} .canvas-context-menu__item`;
const DIALOG = ".dlg";

test.describe("提示词片段", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			try {
				globalThis.localStorage?.clear();
			} catch {
				// 忽略。
			}
		});
	});

	test("节点右键保存为片段，输入框 # 引用该片段", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		// 建一个文本节点并写入 prompt（模拟已提交的提示词）。
		const created = await createNode(page, {
			nodeType: "text",
			position: { x: 220, y: 160 },
			commandId: "e2e-snippet-text"
		});
		expect(created.ok).toBe(true);
		const canvas = await readStoredCanvas(page);
		const node = canvas!.document.nodes.find((entry) => entry.type === "text")!;

		// 写入 canonical prompt（右键保存读取 canonical nodeData.prompt）。
		await page.evaluate((nodeId) => {
			const submit = (window as unknown as {
				__canvasSubmitCommands?: (commands: unknown[], id: string) => unknown;
			}).__canvasSubmitCommands;
			submit?.([{ type: "nodeData.patch", nodeId, value: { prompt: "为这只猫生成写实照片" } }], "e2e-snippet-prompt");
		}, node.id);
		await waitForPersistedRevision(page, 2);

		// 右键节点 → 打开菜单 → 出现「保存为片段…」。
		const box = await page.locator("#bevy-canvas").boundingBox();
		expect(box).not.toBeNull();
		const nodePosition = (node as unknown as { position: { x: number; y: number } }).position;
		await page.mouse.move(box!.x + nodePosition.x + 40, box!.y + nodePosition.y + 40);
		await page.mouse.down({ button: "right" });
		await page.mouse.up({ button: "right" });
		await expect(page.locator(MENU)).toBeVisible();
		await page.locator(ITEM, { hasText: "保存为片段" }).click();

		// 编辑器打开，正文预填。
		await expect(page.locator(DIALOG)).toBeVisible();
		await expect(page.locator(".snippet-editor__field input").first()).toBeVisible();
		await page.locator(".snippet-editor__field input").first().fill("E2E 片段");
		await page.getByRole("button", { name: "保存" }).click();

		// 保存后编辑器关闭。
		await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 15_000 });

		// 选中节点显示执行面板，输入框键入 `#` 触发片段候选。
		// Dialog 关闭后不会恢复先前 panel；先清空选择，再从节点进入。
		await page.mouse.click(box!.x + 800, box!.y + 200);
		await page.mouse.click(box!.x + nodePosition.x + 80, box!.y + nodePosition.y + 60);
		await expect(page.locator(DOCK)).toBeVisible();
		const editor = page.locator(`${DOCK} .mention-editor__input`);
		await editor.click();
		// 清空已有草稿，确保 `#` 在起始位置触发（触发规则：起始或空白后）。
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.press("Delete");
		await page.keyboard.type("#");
		await expect(page.locator(".mention-menu[role='listbox'][aria-label='片段候选']")).toBeVisible({ timeout: 15_000 });
		await page.locator(".mention-menu__item", { hasText: "E2E 片段" }).first().click();

		// 片段正文被插入到草稿输入框。
		await expect(editor).toContainText("为这只猫生成写实照片", { timeout: 10_000 });
	});
});
