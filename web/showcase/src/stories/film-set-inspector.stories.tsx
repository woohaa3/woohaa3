/**
 * 片场检查面板 Showcase（生产组件）
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 7.1 / design D7；
 *  showcase-acceptance：使用生产 shell/镜头/对象与适配组件，不复制业务 UI）。
 *
 * 直接组合生产 `FilmSetInspector` 单栏与 `FilmSetAdaptationConfirm`。
 * fixtures 覆盖多对象、长名称、空集合、只读和动作失配，以及两种面板宽度。
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

/** 多对象 + 选中：生产单栏中的选中属性与删除入口。 */
export const ObjectSelected: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象 · 选中" note="生产单栏与受限变换；删除低强调置于属性末尾。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" />
	</Stage>
);
ObjectSelected.storyName = "对象 · 选中";

/** 无选中：仍显示对象列表与点选提示。 */
export const ObjectNone: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象 · 无选中" note="无选中时展示列表与提示，不回退整体删除。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId={null} />
	</Stage>
);
ObjectNone.storyName = "对象 · 无选中";

/** 长名称：名称完整可读（title 回退）。 */
export const LongNames: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象 · 长名称" note="长名称不破坏布局，完整名称可读。" />
		<FilmSetInspectorStage fixtureId="longName" selectedItemId="a" />
	</Stage>
);
LongNames.storyName = "对象 · 长名称";

/** 空集合：稳定的空态文案，无假对象。 */
export const Empty: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象 · 空片场" note="空集合显示明确空态，不借用假业务控件。" />
		<FilmSetInspectorStage fixtureId="empty" selectedItemId={null} />
	</Stage>
);
Empty.storyName = "对象 · 空片场";

/** 只读 / 历史：写入口禁用，仍可读。 */
export const ReadOnly: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="对象 · 只读" note="历史/只读下写动作禁用，属性可读。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" writable={false} readOnly />
	</Stage>
);
ReadOnly.storyName = "对象 · 只读";

/** 动作失配：从当前片段 binding 读取，确认走 clipPatch。 */
export const Adaptation: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="动作适配 · 失配" note="适配状态来自当前有效片段 binding；确认提交 filmSet.clipPatch。" />
		<FilmSetAdaptationStage />
	</Stage>
);
Adaptation.storyName = "动作适配 · 失配";

/** 390px 面板宽度：单栏内容与对象动作可达。 */
export const Narrow390: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="390px · 片场检查面板" note="390px 宽的侧栏内，镜头与对象控件可用。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" width={390} />
	</Stage>
);
Narrow390.storyName = "390px · 面板宽度";

/** 640px 面板宽度：检查单栏在宽面板下的布局。 */
export const Narrow640: Story = () => (
	<Stage>
		<ProductionFixtureHeader title="640px · 片场检查面板" note="640px 宽的面板内，镜头与对象控件可用。" />
		<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" width={640} />
	</Stage>
);
Narrow640.storyName = "640px · 面板宽度";
