import type { Story, StoryDefault } from "@ladle/react";
import { ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { audioAsset } from "../fixtures/media.js";
import { baseCanvas, canvasFixture } from "../fixtures/canvas.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";
import { ShowcasePanelHost as PanelHost } from "../fixtures/panel-fixture.js";

export default {
	title: "画布组件/执行面板/生产组合/音频",
} satisfies StoryDefault;

/**
 * 音频各生产模式（语音 / 音乐）与任务生命周期（任务 4.1）。
 *
 * 音频没有独立的「模式」控件：所选模型就是模式（`defaultsByModel` 里的 `audioMode`
 * 决定音色 / 时长参数）。这里覆盖默认语音、音乐模式与 running/succeeded/failed。
 */
export const VoiceIdle: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="音频 · 语音模式（默认）" note="三段布局：参考 / 文本 / 参数。音色参数来自所选模型。" />
		<ShowcasePanelHost canvas={baseCanvas("audio")} width={420} />
		<OperationLogPanel />
	</FixtureStage>
);
VoiceIdle.storyName = "语音模式";

/** 音乐模式：切换到 music 模型后时长 slider 出现（不同模式的生产行为）。 */
export const MusicMode: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="音频 · 音乐模式" note="music 模型提供时长 slider；打开参数菜单可切换。" />
		<ShowcasePanelHost canvas={baseCanvas("audio")} width={420} />
		<OperationLogPanel />
	</FixtureStage>
);
MusicMode.storyName = "音乐模式";

export const AudioRunning: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="音频 · 生成中" note="processing：展示进度，主操作进入生成中。" />
		<ShowcasePanelHost canvas={canvasFixture("audioRunning")} width={420} />
		<OperationLogPanel />
	</FixtureStage>
);
AudioRunning.storyName = "音频 · 生成中";

export const AudioSucceeded: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="音频 · 已完成" note="successed：状态行显示已完成。" />
		<ShowcasePanelHost canvas={canvasFixture("audioSucceeded")} width={420} />
		<OperationLogPanel />
	</FixtureStage>
);
AudioSucceeded.storyName = "音频 · 已完成";

export const AudioFailed: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="音频 · 失败" note="failed：安全错误 + 可重试，不误显示为无任务或成功。" />
		<ShowcasePanelHost canvas={canvasFixture("audioFailed")} width={420} />
		<OperationLogPanel />
	</FixtureStage>
);
AudioFailed.storyName = "音频 · 失败";

/** 音频有参考输入时：`voice_sample` role 的 chips。 */
export const AudioWithReference: Story = () => {
	const canvas = baseCanvas("audio");
	canvas.assets = [audioAsset("asset-audio")];
	return (
		<FixtureStage>
			<ProductionFixtureHeader title="音频 · 带参考音频" note="fixture 里音频节点带 voice_sample 参考。" />
			<PanelHost canvas={canvas} width={420} />
			<OperationLogPanel />
		</FixtureStage>
	);
};
AudioWithReference.storyName = "带参考音频";
