/**
 * 模型参数查看页 stories
 * （change: add-showcase-history-model-panels，任务 3.1–3.4；
 *  change: remove-model-placement-panel —— 面板移除模型摆放，MCP 模型生成独占面板；
 *  change: 2026-10-07-remove-legacy-node-type-compat —— 旧 generate/edit/shot 类型下线）。
 *
 * 直接渲染生产 `ModelParameterPanel`。面板能力由生产组件按 `nodeType` 决定：只有
 * model3d 与片场（composite-asset + extensionId="film-set"）承载 MCP 模型生成；已下线的 generate/edit/shot 与其它类型整体不渲染。
 * 查看页用注入的 clipboard adapter 观察复制反馈，不连接任何真实服务。
 */
import { useState, type ReactNode } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { ModelParameterPanel } from "../../../frontend/src/cordis/ui/index";
import { createCopyAdapter, type CopyAdapter } from "../model-parameter-fixtures.js";

function useObservedCopy(initial: boolean) {
	const [adapter] = useState(() => createCopyAdapter(initial));
	const [, bump] = useState(0);
	const copyText = async (value: string) => {
		const ok = await adapter.copyText(value);
		bump((n) => n + 1);
		return ok;
	};
	return { adapter, copyText };
}

export default {
	title: "画布组件/模型参数",
} satisfies StoryDefault;

function PanelStage({
	panel,
	note,
}: {
	panel: ReactNode;
	note: ReactNode;
}) {
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{note}</div>
			<div className="showcase__frame">{panel}</div>
		</div>
	);
}

function CopyLog({ adapter }: { adapter: CopyAdapter }) {
	return (
		<output className="showcase__log" data-testid="copy-log">
			{`copyText ×${adapter.calls.length}`}
		</output>
	);
}

/** model3d：MCP 模型生成独占面板（服务器地址 / 提示词指引），不再有模型摆放控件。 */
export const Generate: Story = () => {
	const { adapter: copy, copyText } = useObservedCopy(true);
	return (
		<PanelStage
			note={
				<>
					<code>nodeType="model3d"</code> · MCP 模型生成
				</>
			}
			panel={
				<>
					<ModelParameterPanel
						canvasId="canvas-main"
						nodeId="model-generate-1"
						nodeType="model3d"
						mcpServerUrl="/mcp/model-canvas"
						copyText={copyText}
					/>
					<CopyLog adapter={copy} />
				</>
			}
		/>
	);
};
Generate.storyName = "model3d";

/** 已下线的旧 generate 类型：不再有可编辑内容，面板整体不渲染。 */
export const Edit: Story = () => {
	return (
		<PanelStage
			note={
				<>
					<code>nodeType="edit"</code> · 已下线，不渲染面板
				</>
			}
			panel={<ModelParameterPanel nodeId="model-edit-1" nodeType="edit" />}
		/>
	);
};
Edit.storyName = "已下线的 edit";

/** 已下线的旧 shot 类型：同样不再渲染面板。 */
export const Shot: Story = () => {
	return (
		<PanelStage
			note={
				<>
					<code>nodeType="shot"</code> · 已下线，不渲染面板
				</>
			}
			panel={<ModelParameterPanel nodeId="model-shot-1" nodeType="shot" />}
		/>
	);
};
Shot.storyName = "已下线的 shot";

/** 不支持模型能力的节点类型：面板整体不渲染（生产语义）。 */
export const Unsupported: Story = () => {
	return (
		<PanelStage
			note={
				<>
					<code>nodeType="image"</code> · 不渲染面板
				</>
			}
			panel={<ModelParameterPanel nodeId="node-image-x" nodeType="image" />}
		/>
	);
};
Unsupported.storyName = "不支持类型";

/** disabledReason：控件禁用，并以可访问文本显示具体原因。 */
export const Disabled: Story = () => {
	const { adapter: copy, copyText } = useObservedCopy(true);
	return (
		<PanelStage
			note={
				<>
					<code>disabledReason</code> · 原因可读
				</>
			}
			panel={
				<>
					<ModelParameterPanel
						canvasId="canvas-main"
						nodeId="model-disabled-1"
						nodeType="model3d"
						disabledReason="画布正在同步，暂时无法读取模型。"
						copyText={copyText}
					/>
					<CopyLog adapter={copy} />
				</>
			}
		/>
	);
};
Disabled.storyName = "被禁用";

/** 复制成功：MCP 复制的成功反馈（adapter 返回成功）。 */
export const CopySuccess: Story = () => {
	const { adapter: copy, copyText } = useObservedCopy(true);
	return (
		<PanelStage
			note={
				<>
					复制反馈 · <code>成功</code>
				</>
			}
			panel={
				<>
					<ModelParameterPanel
						canvasId="canvas-main"
						nodeId="model-copy-ok"
						nodeType="model3d"
						mcpServerUrl="/mcp/model-canvas"
						copyText={copyText}
					/>
					<CopyLog adapter={copy} />
				</>
			}
		/>
	);
};
CopySuccess.storyName = "复制成功";

/** 复制失败：adapter 拒绝复制，面板显示失败反馈。 */
export const CopyFailure: Story = () => {
	const { adapter: copy, copyText } = useObservedCopy(false);
	return (
		<PanelStage
			note={
				<>
					复制反馈 · <code>失败</code>
				</>
			}
			panel={
				<>
					<ModelParameterPanel
						canvasId="canvas-main"
						nodeId="model-copy-fail"
						nodeType="model3d"
						mcpServerUrl="/mcp/model-canvas"
						copyText={copyText}
					/>
					<CopyLog adapter={copy} />
				</>
			}
		/>
	);
};
CopyFailure.storyName = "复制失败";

/** sidebar：360px 侧栏宽度下 MCP 内容不裁切、可滚动。 */
export const Sidebar: Story = () => {
	const { adapter: copy, copyText } = useObservedCopy(true);
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">
				<code>ModelParameterPanel</code> · sidebar 360px
			</div>
			<div className="showcase__frame showcase__frame--sidebar">
				<ModelParameterPanel
					canvasId="canvas-main"
					nodeId="model-sidebar-1"
					nodeType="model3d"
					copyText={copyText}
				/>
			</div>
			<CopyLog adapter={copy} />
		</div>
	);
};
Sidebar.storyName = "sidebar 360";

/** 窄屏 390px：MCP 内容与反馈不裁切、不横向溢出。 */
export const Narrow: Story = () => {
	const { copyText } = useObservedCopy(true);
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">
				<code>ModelParameterPanel</code> · 390px 窄屏
			</div>
			<div className="showcase__frame showcase__frame--narrow">
				<ModelParameterPanel
					canvasId="canvas-main"
					nodeId="model-narrow-1"
					nodeType="model3d"
					disabledReason="窄屏验证：内容必须完整可达。"
					copyText={copyText}
				/>
			</div>
		</div>
	);
};
Narrow.storyName = "窄屏 390";
