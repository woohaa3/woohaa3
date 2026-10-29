import { useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { Button, IconButton, Tooltip, TooltipIfPresent, Popover, DropdownMenu, MenuRadioItem, MenuSeparator, CursorMenu, DialogSurface, DialogSurfaceRoot, Tabs, SegmentedControl, Collapsible, ScrollArea, Switch, UiProvider, UiPortalScope, type MenuItem } from "@woohaa3/ui/primitives";
import { ZoomInIcon, CopyIcon, CloseIcon, TrashIcon } from "@woohaa3/ui/icons";
import { OperationLogPanel, ProductionFixtureHeader } from "../test-support/story-stage.js";

export default {
	title: "画布组件/生产 UI primitives",
} satisfies StoryDefault;

function Stage({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
	const [events, record] = useState<string[]>([]);
	return (
		<div className="showcase__stage" onClickCapture={event => { const button = (event.target as HTMLElement).closest("button"); if (button && !button.disabled) record(old => [...old, button.textContent || button.getAttribute("aria-label") || "操作"]); }}>
			<ProductionFixtureHeader title={title} note={note} />
			<div className="showcase__primitive-stage">{children}</div>
			<output data-ui-recorder>{events.length} 次操作：{events.join(" / ")}</output>
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
						{ id: "copy", label: "复制", onSelect: () => setOpen(false) },
						{ id: "delete", label: "删除", danger: true, separatorBefore: true, onSelect: () => setOpen(false) }
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

/** TooltipIfPresent：内容为空时不包触发器，disabled 时不弹出。 */
export const TooltipPresence: Story = () => (
	<Stage title="Tooltip / TooltipIfPresent" note="空内容与 disabled 不产生浮层；有内容时 hover/focus 可发现。">
		<div className="showcase__row">
			<Tooltip content="有内容">
				<Button>有提示</Button>
			</Tooltip>
			<TooltipIfPresent content="">
				<Button>无内容：不包 Tooltip</Button>
			</TooltipIfPresent>
			<TooltipIfPresent content={null}>
				<Button>null 内容：不包 Tooltip</Button>
			</TooltipIfPresent>
			<Tooltip content="禁用时不显示" disabled>
				<Button>禁用提示</Button>
			</Tooltip>
			<Tooltip content="向上" side="top" align="start">
				<Button size="sm">方向与对齐</Button>
			</Tooltip>
		</div>
	</Stage>
);
TooltipPresence.storyName = "提示有无内容";

/** Canvas 光标菜单：右键定位、禁用项原因、分隔线、子菜单与单次 select。 */
export const CursorMenuAtPoint: Story = () => {
	const [open, setOpen] = useState(false);
	const [point, setPoint] = useState({ x: 120, y: 120 });
	const [last, setLast] = useState("（未选择）");
	const items: MenuItem[] = [
		{ id: "insert", label: "插入节点", onSelect: id => setLast(id) },
		{ id: "paste", label: "粘贴", separatorBefore: true, onSelect: id => setLast(id) },
		{ id: "arrange", label: "排列", children: [
			{ id: "front", label: "置于顶层", onSelect: id => setLast(id) },
			{ id: "back", label: "置于底层", onSelect: id => setLast(id) }
		], onSelect: id => setLast(id) },
		{ id: "delete", label: "删除", danger: true, disabled: true, reason: "只读画布不可删除", onSelect: id => setLast(id) }
	];
	return (
		<Stage title="CursorMenu" note="受控 open；x/y 为 client 坐标，碰撞由 Radix 处理。在虚线区域内右键。">
			<div
				style={{ minHeight: 140, border: "1px dashed var(--app-web-border)", display: "grid", placeItems: "center" }}
				onContextMenu={event => { event.preventDefault(); setPoint({ x: event.clientX, y: event.clientY }); setOpen(true); }}
			>
				右键打开上下文菜单
			</div>
			<Button size="sm" onClick={() => setOpen(true)}>在记录的位置重新打开</Button>
			<output>最后选择：{last}</output>
			<CursorMenu open={open} onOpenChange={setOpen} x={point.x} y={point.y} items={items} label="画布操作" />
		</Stage>
	);
};
CursorMenuAtPoint.storyName = "光标菜单";

/** 菜单选中语义：radio 组、分隔线与禁用项。 */
export const MenuSelection: Story = () => {
	const [view, setView] = useState("grid");
	return (
		<Stage title="DropdownMenu / MenuRadioItem" note="radio 组保持单一选中；禁用项不触发 select。">
			<div className="showcase__row">
				<DropdownMenu
					label="视图"
					trigger={<Button>视图：{view}</Button>}
					radioValue={view}
					onRadioValueChange={value => setView(value)}
				>
					<MenuRadioItem value="grid" active={view === "grid"} onSelect={() => setView("grid")}>网格</MenuRadioItem>
					<MenuRadioItem value="list" active={view === "list"} onSelect={() => setView("list")}>列表</MenuRadioItem>
					<MenuRadioItem value="locked" active={view === "locked"} disabled onSelect={() => undefined}>锁定（不可用）</MenuRadioItem>
					<MenuSeparator className="ui-menu__separator" />
					<MenuRadioItem value="reset" active={false} onSelect={() => setView("grid")}>重置为网格</MenuRadioItem>
				</DropdownMenu>
				<output>当前视图：{view}</output>
			</div>
		</Stage>
	);
};
MenuSelection.storyName = "菜单选中组";

/** UiProvider / UiPortalScope：浮层落在最近作用域的 portal 根，而非 body。 */
export const PortalScope: Story = () => {
	const [open, setOpen] = useState(true);
	return (
		<Stage title="UiProvider / UiPortalScope" note="作用域内 Popover 渲染到 data-ui-portal-scope 容器；关闭后节点随作用域释放。">
			<UiProvider tooltipDelayDuration={0}>
				<div style={{ border: "1px solid var(--app-web-border)", padding: 12, display: "grid", gap: 8 }}>
					<strong>受限作用域</strong>
					<UiPortalScope>
						<Popover open={open} onOpenChange={setOpen} trigger={<Button>作用域内浮层</Button>}>
							<p>这段内容在作用域 portal 根内，不逃逸到应用级容器。</p>
						</Popover>
					</UiPortalScope>
				</div>
			</UiProvider>
			<output>作用域根标记：data-ui-portal-scope；应用级根标记：data-ui-portal-root。</output>
		</Stage>
	);
};
PortalScope.storyName = "Portal 作用域";
