import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Showcase 组件测试。
 *
 * 这里测试的是 story 的组合与生产组件的公开 contract（含用 fixture 注入依赖、
 * 真实挂载生产 `NodeExecutionPanel` 的用例）：
 * - 默认 jsdom；纯结构断言也会在 jsdom 下正常运行。
 * - 交互/滚动/焦点这类需要 DOM 的用例由 `@vitest-environment jsdom` 显式声明。
 *
 * 样式与生产组件由 story 显式 import（`ui.css` / `showcase.css`），测试不重复注入。
 * 两个 setup 分别补齐宿主组件与 fixture/mention 编辑器所需的最小 DOM 垫片。
 */
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["./vitest.setup.ts", "./src/test-setup.ts"],
	},
});
