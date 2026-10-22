/**
 * 片场检查面板 Showcase（生产组件）
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 7.1 / design D7；
 *  showcase-acceptance：使用生产 shell/任务页签/对象与适配组件，不复制业务 UI）。
 *
 * 直接组合生产 `ModelEditorOverlay`（对象/镜头/动画三任务页）、`FilmSetObjectToolbar` 与
 * `FilmSetAdaptationConfirm`。fixtures 覆盖多对象、长名称、空集合、只读和动作失配；窄屏
 * 变体验证 390px 无横向溢出。
 */
import type { ReactNode } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { FilmSetAdaptationStage, FilmSetInspectorStage } from "../film-set-inspector-fixtures.js";
import { ProductionFixtureHeader } from "../fixtures/stage.js";
import "../showcase.css";

export default {
	title: "画布组件/片场检查面板",
} satisfies StoryDefault;

function Stage({ children }: { children: ReactNode }) {
	return <div className="showcase__stage">{children}</div>;
}

/** 多对象 + 选中：生产 shell 与对象页，选中属性与删除入口。 */
export const ObjectSelected: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象页 · 选中" note="生产 ModelEditorOverlay 对象页与受限变换；删除低强调置于属性末尾。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" />
	</Stage>
);
ObjectSelected.storyName = "对象页 · 选中";

/** 无选中：仍显示对象列表与点选提示。 */
export const ObjectNone: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象页 · 无选中" note="无选中时展示列表与提示，不回退整体删除。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId={null} />
	</Stage>
);
ObjectNone.storyName = "对象页 · 无选中";

/** 长名称：名称完整可读（title 回退）。 */
export const LongNames: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象页 · 长名称" note="长名称不破坏布局，完整名称可读。" />
		<FilmSetInspectorStage fixtureId="longName" selectedItemId="a" />
	</Stage>
);
LongNames.storyName = "对象页 · 长名称";

/** 空集合：稳定的空态文案，无假对象。 */
export const Empty: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象页 · 空片场" note="空集合显示明确空态，不借用假业务控件。" />
		<FilmSetInspectorStage fixtureId="empty" selectedItemId={null} />
	</Stage>
);
Empty.storyName = "对象页 · 空片场";

/** 只读 / 历史：写入口禁用，仍可读。 */
export const ReadOnly: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象页 · 只读" note="历史/只读下写动作禁用，属性可读。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" writable={false} readOnly />
	</Stage>
);
ReadOnly.storyName = "对象页 · 只读";

/** 动作失配：从当前片段 binding 读取，确认走 clipPatch。 */
export const Adaptation: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="动作适配 · 失配" note="适配状态来自当前有效片段 binding；确认提交 filmSet.clipPatch。" />
		<FilmSetAdaptationStage />
	</Stage>
);
Adaptation.storyName = "动作适配 · 失配";

/** 390px 窄屏：页签与对象动作可达、无横向溢出。 */
export const Narrow390: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="390px · 片场检查面板" note="窄屏下面板与页签可达且不横向溢出。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" width={390} />
	</Stage>
);
Narrow390.storyName = "390px · 窄屏";

/** 640px 窄屏：三任务页在中等窄屏下可用。 */
export const Narrow640: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="640px · 片场检查面板" note="640px 下面板与三任务页可用且不横向溢出。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" width={640} />
	</Stage>
);
Narrow640.storyName = "640px · 窄屏";
