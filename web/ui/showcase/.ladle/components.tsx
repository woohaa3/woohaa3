import { useEffect, useState, type ReactNode } from "react";
import type { GlobalProvider } from "@ladle/react";
import { showcaseThemeService, ThemeProvider, ThemeToggle } from "../src/theme.js";
import { ShowcaseSidebar } from "../src/shell/ShowcaseSidebar.js";
import { installFixedClock } from "../src/fixed-clock.js";
import { IconButton, Tooltip, UiProvider } from "@woohaa3/ui/primitives";
import { LayoutGridIcon } from "@woohaa3/ui/icons";
// 组件库样式（Dialog / 右键菜单 / 右下角控件 / mention / 片段库 / 任务历史 / 模型参数 /
// 执行面板）与宿主页面共用同一份。主题变量来自 Theme Provider 写入的根级 `--app-*`。
import "../../../frontend/src/cordis/ui/ui.css";
import "../../../frontend/src/index.css";
import "../src/showcase.css";

/**
 * 全局 Provider。
 *
 * 1. 挂载 `ThemeProvider` —— 与生产应用共用同一 Theme Service 契约，支持默认/哨兵 preset。
 * 2. 固定查看页的默认 locale / timezone：任务历史的时间文本与截图必须跨机器可重复
 *    （change: add-showcase-history-model-panels，任务 2.3）。
 * 3. 提供紧凑的 Showcase 壳层：品牌工具栏 + 自有侧栏 + story 内容区。
 *    Ladle 仍负责 story 发现 / 构建 / 渲染当前 story（默认 mode=preview）；
 *    侧栏、导航与主题切换都是 Showcase 自己的组件，不读取 Ladle 内部 DOM。
 *
 * change: 2026-09-29-refresh-showcase-shell（design D1/D2/D7/D8）。
 */
export const Provider = ((props: {
	children?: ReactNode;
	globalState?: { story?: string };
}) => {
	const { children, globalState } = props;
	// 宽屏默认展开导航；窄屏默认收起，避免 248px 侧栏把 story 内容挤到不可用
	// （可随时用工具栏按钮切换）。viewport 在挂载前已确定，故只需初始化读取一次。
	const [sidebarOpen, setSidebarOpen] = useState(
		() => typeof window === "undefined" || window.matchMedia("(min-width: 900px)").matches,
	);
	useEffect(() => installFixedClock(), []);
	// showcase 的 ThemeProvider 只把变量写到内部 .app-theme-root；外壳的 --showcase-* 与旧组件
	// 的 --mc-* 在 :root 上解析，因此必须把同一 snapshot 也 apply 到 documentElement，否则暗色
	// 预览会出现「story 变暗、外壳/兼容 alias 仍是浅色」的半明半暗。（生产由 installAppServices
	// 对 documentElement apply，showcase 需要显式补这一步。）
	useEffect(() => showcaseThemeService.applyTo(document.documentElement), []);
	return (
		<ThemeProvider service={showcaseThemeService}>
			<UiProvider tooltipDelayDuration={250}>
				<div className="showcase" data-sidebar={sidebarOpen ? "open" : "closed"}>
					<header className="showcase__toolbar">
						<div className="showcase__toolbar-inner">
							<span className="showcase__brand">
								<Tooltip content={sidebarOpen ? "收起组件导航" : "展开组件导航"}>
									<IconButton
										className="showcase__icon-button"
										label={sidebarOpen ? "收起组件导航" : "展开组件导航"}
										size="sm"
										aria-expanded={sidebarOpen}
										onClick={() => setSidebarOpen((open) => !open)}
									>
										<LayoutGridIcon size={16} />
									</IconButton>
								</Tooltip>
								<LayoutGridIcon className="showcase__brand-icon" />
								<span className="showcase__brand-name">Woohaa Component Lab</span>
							</span>
							<ThemeToggle />
						</div>
					</header>
					<div className="showcase__body">
						{sidebarOpen ? <ShowcaseSidebar currentStory={globalState?.story ?? null} /> : null}
						<main className="showcase__content">{children}</main>
					</div>
				</div>
			</UiProvider>
		</ThemeProvider>
	);
}) satisfies GlobalProvider;
