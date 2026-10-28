import type { Story, StoryDefault } from "@ladle/react";
import { ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { baseCanvas, canvasFixture } from "../fixtures/canvas.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";

export default {
	title: "画布组件/执行面板/Model Interaction Plugin",
} satisfies StoryDefault;

/**
 * Generic model interaction Plugin
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 7.1）。
 *
 * 生产 `ModelExecutionHost` 从 Registry 解析 `generic-model@1` 并渲染 generic Plugin Panel；
 * 文本 / 图片 / 音频 / 普通视频共用一个生产实现。
 */
export const GenericImage: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="generic · 图片"
			note="catalog 声明 generic-model@1；Host 精确解析 Registry 并渲染 generic Panel。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} />
		<OperationLogPanel />
	</FixtureStage>
);
GenericImage.storyName = "generic · 图片";

export const GenericText: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="generic · 文本" note="同一 generic Plugin 复用；提交仍固定各自 modelKey。" />
		<ShowcasePanelHost canvas={baseCanvas("image")} catalogId="languageOnly" />
		<OperationLogPanel />
	</FixtureStage>
);
GenericText.storyName = "generic · 文本";

export const GenericAudio: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="generic · 音频" note="generic Panel 按 catalog schema 呈现音色/时长参数。" />
		<ShowcasePanelHost canvas={baseCanvas("audio")} />
		<OperationLogPanel />
	</FixtureStage>
);
GenericAudio.storyName = "generic · 音频";

/** 两个 Provider 的同名 providerModelId：不同 modelKey、互不冲突，复用同一 interaction。 */
export const ProviderAlias: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="Provider 同名模型"
			note="litellm:gpt-image-2 与 vertex:gpt-image-2 身份隔离，可复用同一个 generic Plugin。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} catalogId="providerAlias" />
		<OperationLogPanel />
	</FixtureStage>
);
ProviderAlias.storyName = "Provider 同名模型";

/** Seedance 专用 Plugin：Panel 只显示入口与 intent 摘要；复杂编辑器在 Plugin 的 Dialog。 */
export const SeedancePanel: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="Seedance 专用 Panel"
			note="编辑入口打开 Plugin 注册的 Dialog（此处 fixture 记录请求）；Panel 不嵌入时间轴。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("editVideoReady")} catalogId="seedance" />
		<OperationLogPanel />
	</FixtureStage>
);
SeedancePanel.storyName = "Seedance 专用 Panel";

/** 缺少 interaction Plugin：显示诊断、禁用提交，且不回退 generic。 */
export const MissingPlugin: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="缺 Plugin"
			note="catalog 声明的 interaction 未注册：Host 显示诊断并禁用提交，不渲染 generic Panel。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} catalogId="missingPlugin" />
		<OperationLogPanel />
	</FixtureStage>
);
MissingPlugin.storyName = "缺 Plugin";

/** Version mismatch：id 匹配但 version 不匹配，同样进入诊断且不回退。 */
export const VersionMismatch: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="Version mismatch"
			note="generic-model@99 未注册：精确匹配失败，显示诊断且不回退 generic-model@1。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} catalogId="versionMismatch" />
		<OperationLogPanel />
	</FixtureStage>
);
VersionMismatch.storyName = "Version mismatch";

/** Catalog 不可用：显示阻止原因 + 重试，不猜测本地 Plugin 或 Provider 路由。 */
export const CatalogUnavailable: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="catalog 不可用"
			note="available=false：显示阻止原因与重试，不渲染任何模型 Panel。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} catalogId="unavailable" />
		<OperationLogPanel />
	</FixtureStage>
);
CatalogUnavailable.storyName = "catalog 不可用";

/** 390px 窄屏（任务 7.4）：诊断与泛用 Panel 均无横向 overflow。 */
export const Narrow390: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="390px · Seedance" note="窄屏下 Panel、入口与摘要可达且不横向溢出。" />
		<ShowcasePanelHost canvas={canvasFixture("editVideoReady")} catalogId="seedance" width={390} />
		<OperationLogPanel />
	</FixtureStage>
);
Narrow390.storyName = "390px · Seedance";
