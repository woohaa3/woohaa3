import type { Story, StoryDefault } from "@ladle/react";
import { ShowcaseAnchorSkeletonSwap, ShowcasePanelHost } from "../fixtures/panel-fixture.js";
import { baseCanvas, canvasFixture } from "../fixtures/canvas.js";
import { FixtureStage, OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";
export default {
	title: "画布组件/执行面板/生产组合",
} satisfies StoryDefault;

/**
 * 生产 `ModelExecutionHost`（不是裸 `ExecutionPanel`/textarea）。
 *
 * fixture 只注入 catalog / session / run / reference 依赖；组件内部仍走
 * `woohaa3CanvasStore` 上下文解析、MentionEditor、ReferenceTileStrip、菜单与提交协调器。
 */
export const ImageIdle: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="图片 · 生产组合"
			note="prompt、参考 chips、模型 / 参数 / 快捷改写菜单全部来自生产组件。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} />
		<OperationLogPanel />
	</FixtureStage>
);
ImageIdle.storyName = "图片 · 生产组合";

export const AnchorBelow: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="节点锚点 · 下方" note="生产锚定宿主使用舞台提供的虚拟节点矩形。" />
		<ShowcasePanelHost canvas={baseCanvas("image")} anchor="center" />
	</FixtureStage>
);
AnchorBelow.storyName = "锚点 · 下方";

export const AnchorFlip: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="节点锚点 · 边缘翻转" note="底边节点优先在上方呈现，左右边缘由生产定位函数纠偏。" />
		<ShowcasePanelHost canvas={baseCanvas("image")} anchor="bottom" />
	</FixtureStage>
);
AnchorFlip.storyName = "锚点 · 上方翻转";

export const AnchorUnavailable: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="节点锚点 · 几何失效" note="离屏与未就绪锚点保持隐藏，route 与草稿不变。" />
		<ShowcasePanelHost canvas={baseCanvas("image")} anchor="offscreen" />
		<ShowcasePanelHost canvas={baseCanvas("image")} anchor="missing" />
	</FixtureStage>
);
AnchorUnavailable.storyName = "锚点 · 离屏与未就绪";

export const AnchorSkeletonSwap: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="节点锚点 · 骨架替换" note="骨架切换为真实内容时沿用同一个节点锚定宿主。" />
		<ShowcaseAnchorSkeletonSwap />
	</FixtureStage>
);
AnchorSkeletonSwap.storyName = "锚点 · 骨架替换";

/** 侧栏面：参数与执行动作在各状态下的可用性（任务 3.3）。 */
export const Sidebar: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title='surface="sidebar"'
			note="surface 传入生产组件；窄栏里菜单、tiles 与执行动作不得重叠，执行按钮整行铺满。"
		/>
		<div className="showcase__sidebar-box">
			<ShowcasePanelHost canvas={baseCanvas("image")} surface="sidebar" />
		</div>
		<OperationLogPanel />
	</FixtureStage>
);
Sidebar.storyName = "侧栏面";

/** dock 面：铺满容器 + 分区式布局。 */
export const Dock: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title='surface="dock"' note="surface 传入生产组件；面板取容器宽高，内部走分区式布局。" />
		<div className="showcase__dock-box">
			<ShowcasePanelHost canvas={baseCanvas("image")} surface="dock" />
		</div>
		<OperationLogPanel />
	</FixtureStage>
);
Dock.storyName = "dock 面";

/** 受控 presentation：compact → expanded → compact（fullscreen panel host，非 Dialog）。 */
export const Presentation: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="compact / expanded 受控 presentation"
			note="展开/收起通过 onPresentationIntent 驱动同一 ModelExecutionHost；操作日志记录 panelPresentation，关闭记录 panelClose。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} />
		<OperationLogPanel />
	</FixtureStage>
);
Presentation.storyName = "compact / expanded";

/** 390px 窄屏：输入区、chips、菜单与底部动作不能横向溢出。 */
export const Narrow390: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="390px 窄屏"
			note="展开参数菜单后仍完整位于可视区域，prompt / chips / 提交动作不被不可恢复地遮挡。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} width={390} />
		<OperationLogPanel />
	</FixtureStage>
);
Narrow390.storyName = "390px 窄屏";

/** 只读（断线）状态：不得提交任务，但仍能查看信息（任务 2.3）。 */
export const ReadOnly: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader
			title="只读（断线）"
			note="writable=false：执行动作禁用；只读状态由左下角同步状态提示，面板内不重复原因。"
		/>
		<ShowcasePanelHost canvas={baseCanvas("image")} writable={false} />
		<OperationLogPanel />
	</FixtureStage>
);
ReadOnly.storyName = "只读";

/** 空 prompt：禁用原因是「没有提示词」，而不是宿主 blocking（任务 2.3）。 */
export const EmptyPrompt: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="空 prompt" note="提示词为空：主操作禁用，但参数与菜单仍可查看。" />
		<ShowcasePanelHost canvas={canvasFixture("emptyPrompt")} />
		<OperationLogPanel />
	</FixtureStage>
);
EmptyPrompt.storyName = "空 prompt";

/** 未装配片段插件：`#` 入口不出现（与生产一致）。 */
export const WithoutSnippetSource: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="未装配片段插件" note="snippetSource 缺省：编辑框不出现 `#` 入口。" />
		<ShowcasePanelHost canvas={baseCanvas("image")} snippetSource={false} />
		<OperationLogPanel />
	</FixtureStage>
);
WithoutSnippetSource.storyName = "未装配片段插件";

/** 图片任务生命周期：running / failed。 */
export const ImageRunning: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="图片 · 生成中" note="processing：展示进度，主操作进入生成中。" />
		<ShowcasePanelHost canvas={canvasFixture("imageRunning")} />
		<OperationLogPanel />
	</FixtureStage>
);
ImageRunning.storyName = "图片 · 生成中";

export const ImageFailed: Story = () => (
	<FixtureStage>
		<ProductionFixtureHeader title="图片 · 失败" note="failed：错误详情可展开，不误显示为无任务或成功。" />
		<ShowcasePanelHost canvas={canvasFixture("imageFailed")} />
		<OperationLogPanel />
	</FixtureStage>
);
ImageFailed.storyName = "图片 · 失败";
