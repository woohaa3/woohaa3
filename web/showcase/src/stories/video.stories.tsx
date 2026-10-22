import type { Story, StoryDefault } from "@ladle/react";
import { ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { canvasFixture } from "../fixtures/canvas.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";

export default {
	title: "画布组件/执行面板/生产组合/视频",
} satisfies StoryDefault;

/** 视频默认（omni_reference）与任务生命周期。 */
export const OmniIdle: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="视频 · 默认模式" note="omni_reference：普通参考角色。" />
		<ShowcasePanelHost canvas={canvasFixture("empty")} width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
OmniIdle.storyName = "默认模式";

export const VideoRunning: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="视频 · 生成中" note="processing：展示进度。" />
		<ShowcasePanelHost canvas={canvasFixture("videoRunning")} width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
VideoRunning.storyName = "视频 · 生成中";

export const VideoFailed: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="视频 · 失败" note="failed：安全错误 + 可重试。" />
		<ShowcasePanelHost canvas={canvasFixture("videoFailed")} width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
VideoFailed.storyName = "视频 · 失败";

/**
 * `edit_video` 模式 + 编辑入口 + intent chips（任务 4.2）。
 *
 * 完整视频编辑弹窗由 `port-video-editing-dialogs` / `canvas-video-workflow` 提供；本 change
 * 只展示入口与已有 intent 摘要。点击 intent 触发 `onOpenVideoEditIntent`，fixture 记录请求。
 */
export const EditVideoReady: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="视频 · edit_video（ready 输入）"
			note="Seedance 专用 Panel：入口打开 Plugin 注册的 Dialog，intent chips 由 Plugin 提供。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("editVideoReady")} catalogId="seedance" width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
EditVideoReady.storyName = "edit_video · ready";

/** `edit_video` 缺输入视频：入口禁用并显示原因。 */
export const EditVideoMissing: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="视频 · edit_video（缺输入）"
			note="没有 ready 输入视频：入口禁用，执行被阻止并说明「恰好一个 edit_video」。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("editVideoMissing")} catalogId="seedance" width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
EditVideoMissing.storyName = "edit_video · 缺输入";
