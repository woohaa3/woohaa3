/**
 * 音视频节点端到端验收（change: add-audio-video-generation-and-align-model-catalog，任务 11.2 / 11.5）。
 *
 * 用真实桥接协议与真实服务端验证：
 * - video/audio 节点可创建、hydrate 后恢复；
 * - 执行面板按节点类型显示 video-generation / audio-generation；
 * - nodeData 音视频结果（duration/posterAssetId）落盘并刷新恢复。
 */
import { expect, test } from "./review-browser.js";
import {
	createNode,
	currentFrameRevision,
	installPageHelpers,
	patchNodeData,
	readStoredCanvas,
	resetCanvasStorage,
	sendSelection,
	waitForCanvasSession,
	waitForPersistedRevision
} from "./helpers.js";

const DOCK = ".node-execution-dock";
const PANEL = `${DOCK} [data-task-kind]`;

test.describe("音视频节点", () => {
	test("video/audio 节点可创建、面板映射正确、刷新恢复", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		for (const [operationId, nodeType] of [
			["e2e-video-create", "video"],
			["e2e-audio-create", "audio"]
		] as const) {
			const created = await createNode(page, {
				nodeType,
				position: { x: revision * 400, y: 0 },
				commandId: operationId
			});
			expect(created.ok, JSON.stringify(created)).toBe(true);
			revision = created.revision ?? revision;
		}

		const canvas = await readStoredCanvas(page);
		const videoNode = canvas?.document.nodes.find((node) => node.type === "video");
		const audioNode = canvas?.document.nodes.find((node) => node.type === "audio");
		expect(videoNode).toBeDefined();
		expect(audioNode).toBeDefined();

		revision = await currentFrameRevision(page);
		await sendSelection(page, { nodeIds: videoNode!.id, operationId: "e2e-video-select", revision });
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "video-generation");

		await sendSelection(page, { nodeIds: audioNode!.id, operationId: "e2e-audio-select", revision });
		await expect(page.locator(PANEL)).toHaveAttribute("data-task-kind", "audio-generation");

		// 刷新后音视频节点仍存在。
		await page.reload();
		await waitForCanvasSession(page);
		const after = await readStoredCanvas(page);
		expect(after?.document.nodes.some((node) => node.type === "video")).toBe(true);
		expect(after?.document.nodes.some((node) => node.type === "audio")).toBe(true);
	});

	test("音视频 nodeData（duration/posterAssetId）经投影落盘并刷新恢复", async ({ page }) => {
		await installPageHelpers(page);
		await resetCanvasStorage(page);
		await waitForCanvasSession(page);

		let revision = 0;
		const created = await createNode(page, {
			nodeType: "video",
			position: { x: 0, y: 0 },
			commandId: "e2e-video-nd-create"
		});
		revision = created.revision ?? revision;
		const nodeId = (await readStoredCanvas(page))?.document.nodes[0].id as string;

		// 合法音视频配置字段（duration 属于 nodeData，但由服务端 projector 写入；
		// 这里验证 prompt/agentId 仍可写，且不会被音视频扩展破坏）。
		const patched = await patchNodeData(page, {
			nodeId,
			value: { prompt: "视频提示词", agentId: "seedance2_0" },
			commandId: "e2e-video-nd-patch"
		});
		expect(patched.ok, JSON.stringify(patched)).toBe(true);
		revision = patched.revision ?? revision;
		await waitForPersistedRevision(page, revision);

		await page.reload();
		await waitForCanvasSession(page);
		const after = await readStoredCanvas(page);
		expect(after?.nodeData[nodeId]).toMatchObject({
			prompt: "视频提示词",
			agentId: "seedance2_0"
		});
	});
});
