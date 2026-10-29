import type { Story, StoryDefault } from "@ladle/react";
import { ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { canvasFixture } from "../fixtures/canvas.js";
import { CatalogFixturePanel } from "../fixtures/catalog-stories.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";

export default {
	title: "画布组件/执行面板/提示词与引用",
} satisfies StoryDefault;

/**
 * `@` 素材 mention 与 `#` 片段 typeahead
 * （任务 2.1 / spec「Prompt story SHALL 覆盖素材与片段 typeahead」）。
 *
 * 打开方式：点击编辑框，输入 `@` 或 `#`，再输入关键字筛选、用方向键选择、Enter/点击确认。
 * 插入结果由生产 `MentionEditor` 生成 token，而不是拼接 fixture 字符串。
 */
export const MentionAndSnippetTypeahead: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="`@` 素材 / `#` 片段 typeahead"
			note="在编辑框输入 `@` 打开素材候选，输入 `#` 打开片段候选；空结果时菜单不出现。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("readyReferences")} />
		<OperationLogPanel />
	</FixtureStage>
);
MentionAndSnippetTypeahead.storyName = "素材 / 片段 typeahead";

/** ready reference tile：缩略图 + 可访问状态，可移除、可打开 picker。 */
export const ReadyReference: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="ready 引用" note="方形 tile 显示缩略图与角色标签，可移除或打开 picker 追加。" />
		<ShowcasePanelHost canvas={canvasFixture("readyReferences")} />
		<OperationLogPanel />
	</FixtureStage>
);
ReadyReference.storyName = "ready 引用";

/** 超过三个引用：单行横向滚动，全部保留在 DOM。 */
export const ManyReferences: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="多素材横向滚动"
			note="5 个引用 + add tile 在同一行横向滚动；不折叠、不换行、无展开按钮。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("manyReferences")} width={390} />
		<OperationLogPanel />
	</FixtureStage>
);
ManyReferences.storyName = "多素材横向滚动";

/** pending reference：显示等待中，且因输入未就绪而阻止执行并解释原因。 */
export const PendingReference: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="pending 引用"
			note="tile 状态为「等待中」，执行被阻止并给出具体原因；用户仍可移除引用。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("pendingReference")} />
		<OperationLogPanel />
	</FixtureStage>
);
PendingReference.storyName = "pending 引用";

/** unavailable reference：模型不接受该媒体类型 → invalid + 解释。 */
export const UnavailableReference: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="unavailable 引用"
			note="tile 状态为「不可用」并说明原因，而不是只靠颜色表达。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("unavailableReference")} />
		<OperationLogPanel />
	</FixtureStage>
);
UnavailableReference.storyName = "unavailable 引用";

/** reference picker：打开候选并回传选择（fixture 记录 edge 命令）。 */
export const ReferencePicker: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="reference picker"
			note="点击 add tile 打开非模态 picker；方向键/Home/End/Enter 选择，选中后 fixture 记录一次 edge.add 命令。"
		/>
		<ShowcasePanelHost canvas={canvasFixture("pickerCandidates")} />
		<OperationLogPanel />
	</FixtureStage>
);
ReferencePicker.storyName = "reference picker";

/** catalog loading：目录区域显示加载中，不与空列表混淆。 */
export const CatalogLoading: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="catalog loading" note="目录尚未返回：模型区域加载中，主操作被阻止。" />
		<CatalogFixturePanel catalogId="loading" />
		<OperationLogPanel />
	</FixtureStage>
);
CatalogLoading.storyName = "catalog 加载中";

/** catalog error / retry：先失败，重试成功后可选模型（任务 3.2）。 */
export const CatalogErrorRetry: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="catalog error + retry"
			note="首次加载失败显示重试；点击「重新加载模型目录」后成功并可打开模型菜单。"
		/>
		<CatalogFixturePanel catalogId="error" />
		<OperationLogPanel />
	</FixtureStage>
);
CatalogErrorRetry.storyName = "catalog 失败 / 重试";

/** 空 catalog 与「没有该类型模型」是两个不同状态。 */
export const CatalogEmpty: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="catalog 空" note="available=true 但没有模型：显示「没有可用模型」，不是加载失败。" />
		<CatalogFixturePanel catalogId="empty" />
		<OperationLogPanel />
	</FixtureStage>
);
CatalogEmpty.storyName = "catalog 空";

export const CatalogNoModelForKind: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="没有该类型模型"
			note="目录只有 language 模型：图片面板提示该节点没有可用模型，与空 catalog 区分。"
		/>
		<CatalogFixturePanel catalogId="languageOnly" />
		<OperationLogPanel />
	</FixtureStage>
);
CatalogNoModelForKind.storyName = "没有该类型模型";
