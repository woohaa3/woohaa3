import type { Story, StoryDefault } from "@ladle/react";
import { ShowcasePanelHost, recordPromptSkill } from "../fixtures/panel-fixture.js";
import { baseCanvas } from "../fixtures/canvas.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";

export default {
	title: "画布组件/执行面板/生产组合/菜单",
} satisfies StoryDefault;

/**
 * 模型菜单 / 参数菜单 / 快捷改写菜单的展开、键盘导航与选择（任务 3.1）。
 *
 * 菜单是生产 `ExecutionPanel` 内部的 `ModelSelector` / `SettingsMenu` / polish menu：
 * - 模型菜单：`aria-haspopup="menu"`，选项 `role="menuitemradio"`；
 * - 参数菜单：按模型 schema 投影，slider / select / boolean 控件；
 * - 快捷改写：选中后把「所选 action + 当前草稿」交给 `onPromptSkill`（fixture 记录）。
 */
export const Menus: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="模型 / 参数 / 快捷改写菜单"
			note="点击模型选择器、参数摘要或快捷改写图标展开；快捷键 Esc / 点击外部关闭。选择结果记入 fixture。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} onPromptSkill={recordPromptSkill} />
		<OperationLogPanel />
	</FixtureStage>
);
Menus.storyName = "三组菜单";

/** 只有基础参数（无 slider）的模型：验证参数菜单按 schema 投影。 */
export const VideoParameters: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="视频参数菜单"
			note="视频模型的时长是 slider、生成音频是 checkbox；参数摘要随选择更新。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("video")} width={480} />
		<OperationLogPanel />
	</FixtureStage>
);
VideoParameters.storyName = "视频参数";
