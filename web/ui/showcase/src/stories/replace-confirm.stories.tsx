import type { Story, StoryDefault } from "@ladle/react";
import { DialogStage, createReplaceConfirmRenderer, PASTE_REPLACE_DIALOG_ID } from "../snippet-fixtures.js";

export default {
	title: "画布组件/弹窗/单图替换",
} satisfies StoryDefault;

/** 粘贴单张图片且选中一个图片节点时的确认弹窗：创建新节点 / 替换 / 取消。 */
export const ReplaceConfirm: Story = () => {
	const renderer = createReplaceConfirmRenderer(async () => ({ ok: true }));
	return (
		<DialogStage
			renderer={renderer}
			instanceId={PASTE_REPLACE_DIALOG_ID}
			payload={{ intentId: "intent-1", fileName: "screenshot-2026-09-27.png", nodeLabel: "主视觉图" }}
			title="替换确认"
			width={420}
		/>
	);
};
ReplaceConfirm.storyName = "默认";
