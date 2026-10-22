import { STORY_ORDER } from "../src/shell/story-order.mjs";

/** @type {import('@ladle/react').UserConfig} */
export default {
	stories: "src/**/*.stories.{ts,tsx}",
	port: 5174,
	previewPort: 4174,
	outDir: "dist",
	// 侧栏由 Showcase 自有组件渲染（src/shell/ShowcaseSidebar.tsx），排序表与
	// src/shell/story-order.mjs 共享，避免两处漂移。id 形如
	// 画布组件--执行面板--生产组合--图片-·-生产组合。
	storyOrder: STORY_ORDER,
	appendToHead: `
		<style>
			/* 主题（含 color-scheme）由 ThemeProvider 的 ThemeService 在运行时写到
			 * documentElement；这里不固定明暗，避免暗色预览被硬编码浅色卡住。 */
			/* 内边距交给 .showcase__content 统一控制。 */
			:root { --ladle-main-padding: 0; --ladle-main-padding-mobile: 0; }
		</style>
	`,
	addons: {
		// 壳层已提供主题控件，关闭 Ladle 自带主题开关；其余 addons 保留为调试用。
		theme: { enabled: false },
		// 默认 preview：Provider 输出即整页（自有工具栏 + 侧栏 + story），
		// Ladle 的 full 模式 manager（自带侧栏）不再渲染。
		mode: { enabled: true, defaultState: "preview" },
		control: { enabled: true },
		width: {
			enabled: true,
			options: { node360: 360, node420: 420, node480: 480, wide: 900 },
			defaultState: 0,
		},
		a11y: { enabled: true },
		source: { enabled: true },
	},
};
