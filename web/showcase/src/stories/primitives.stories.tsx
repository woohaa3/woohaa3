import { useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import {
	Button,
	IconButton,
	Tooltip,
	Popover,
	DropdownMenu,
	DialogSurface,
	DialogSurfaceRoot,
	Tabs,
	SegmentedControl,
	Collapsible,
	ScrollArea,
	Switch,
	ZoomInIcon,
	CopyIcon,
	CloseIcon,
	TrashIcon
} from "../../../frontend/src/cordis/ui/index";
import { OperationLogPanel, ProductionFixtureHeader } from "../fixtures/stage.js";

export default {
	title: "画布组件/生产 UI primitives",
} satisfies StoryDefault;

function Stage({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
	return (
		<div className="showcase__stage">
			<ProductionFixtureHeader title={title} note={note} />
			<div className="showcase__primitive-stage">{children}</div>
		</div>
	);
}

/** Button / IconButton 的 size、tone、disabled、loading。 */
export const Buttons: Story = () => (
	<Stage title="Button / IconButton" note="size/tone/disabled/loading 与 icon-only accessible name。">
		<div className="showcase__row">
			<Button>默认</Button>
			<Button tone="primary">主要</Button>
			<Button tone="danger">危险</Button>
			<Button size="sm">小</Button>
			<Button loading>处理中</Button>
			<Button disabled>禁用</Button>
		</div>
		<div className="showcase__row">
			<Tooltip content="放大">
				<IconButton label="放大">
					<ZoomInIcon />
				</IconButton>
			</Tooltip>
			<Tooltip content="复制">
				<IconButton label="复制" tone="primary">
					<CopyIcon />
				</IconButton>
			</Tooltip>
			<IconButton label="删除" tone="danger">
				<TrashIcon />
			</IconButton>
			<IconButton label="禁用" disabled>
				<CloseIcon />
			</IconButton>
		</div>
	</Stage>
);
Buttons.storyName = "按钮";

/** Switch：受控布尔开关，disabled 不接受改变。 */
export const Switches: Story = () => {
	const [on, setOn] = useState(true);
	return (
		<Stage title="Switch" note="受控 checked、accessible name、disabled 不接受 pointer/keyboard 改变。">
			<div className="showcase__row">
				<Switch checked={on} onCheckedChange={setOn} aria-label="启用示例" />
				<Switch checked disabled aria-label="禁用示例" />
			</div>
		</Stage>
	);
};
Switches.storyName = "开关";

/** 受控 Popover 与 DropdownMenu。 */
export const Menus: Story = () => {
	const [open, setOpen] = useState(false);
	return (
		<Stage title="Popover / DropdownMenu" note="受控 open、outside dismiss、Escape、方向键与单次 select。">
			<div className="showcase__row">
				<Popover
					open={open}
					onOpenChange={setOpen}
					trigger={<Button onClick={() => setOpen((value) => !value)}>打开 Popover</Button>}
				>
					<p>受控弹层内容</p>
				</Popover>
				<DropdownMenu
					label="操作"
					trigger={<Button>菜单</Button>}
					items={[
						{ id: "copy", label: "复制", onSelect: () => undefined },
						{ id: "delete", label: "删除", danger: true, separatorBefore: true, onSelect: () => undefined }
					]}
				/>
			</div>
		</Stage>
	);
};
Menus.storyName = "浮层";

/** Tabs 与 single/multiple SegmentedControl。 */
export const TabsAndSegmented: Story = () => {
	const [tab, setTab] = useState("a");
	const [mode, setMode] = useState("default");
	const [tools, setTools] = useState<string[]>(["orbit"]);
	return (
		<Stage title="Tabs / SegmentedControl" note="ARIA、键盘导航、single 不可取消为空。">
			<Tabs
				label="视图"
				value={tab}
				onValueChange={setTab}
				items={[{ value: "a", label: "视图 A" }, { value: "b", label: "视图 B" }]}
				panels={{ a: <p>面板 A</p>, b: <p>面板 B</p> }}
			/>
			<SegmentedControl
				label="主题"
				value={mode}
				onValueChange={setMode}
				options={[{ value: "default", label: "默认" }, { value: "sentinel", label: "哨兵" }]}
			/>
			<SegmentedControl
				type="multiple"
				label="工具"
				value={tools}
				onValueChange={setTools}
				options={[{ value: "orbit", label: "轨道" }, { value: "distance", label: "距离" }]}
			/>
		</Stage>
	);
};
TabsAndSegmented.storyName = "Tabs 与分段控件";

/** Collapsible 与 ScrollArea。 */
export const CollapseAndScroll: Story = () => (
	<Stage title="Collapsible / ScrollArea" note="展开状态与自定义滚动条；382px 内容不产生横向溢出。">
		<Collapsible trigger={<span>展开详情</span>}>
			<p>折叠内容</p>
		</Collapsible>
		<ScrollArea label="长列表" className="showcase__primitive-scroll showcase__primitive-scroll--bounded">
			<ul>
				{Array.from({ length: 20 }, (_, index) => (
					<li key={index}>列表项 {index + 1}</li>
				))}
			</ul>
		</ScrollArea>
	</Stage>
);
CollapseAndScroll.storyName = "折叠与滚动";

/** DialogSurface（standalone）：受控 open 的 modal。 */
export const Dialog: Story = () => {
	const [open, setOpen] = useState(false);
	return (
		<Stage title="DialogSurface" note="受控 open、可访问名、Escape/遮罩关闭请求。">
			<Button tone="primary" onClick={() => setOpen(true)}>
				打开弹窗
			</Button>
			<DialogSurfaceRoot open={open} modal onOpenChange={setOpen}>
				<DialogSurface className="dlg dlg--standard dlg--md" ariaLabel="示例弹窗">
					<div className="dlg__header">
						<h2 className="dlg__title">示例弹窗</h2>
						<IconButton label="关闭" size="sm" onClick={() => setOpen(false)}>
							<CloseIcon />
						</IconButton>
					</div>
					<div className="dlg__body">
						<p>这是生产 DialogSurface adapter 渲染的弹窗。</p>
					</div>
				</DialogSurface>
			</DialogSurfaceRoot>
		</Stage>
	);
};
Dialog.storyName = "弹窗";

/** 诊断面板（生产组件身份）。 */
export const Diagnostics: Story = () => (
	<Stage title="fixture diagnostics" note="生产 fixture 操作记录（Collapsible）。">
		<OperationLogPanel />
	</Stage>
);
Diagnostics.storyName = "诊断";
