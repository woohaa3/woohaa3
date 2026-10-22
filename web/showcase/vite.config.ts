import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localFont } from "./vite-plugins/local-font.js";

// Ladle 只读取项目根的 vite.config.ts，所以 localFont 插件同时服务两个宿主：
// 这里的 Vite 配置，以及 Ladle 自己的 dev/build。
export default defineConfig({
	plugins: [react(), localFont()],
	server: {
		host: true,
		port: 5174,
		// Ladle 的 app 模板经 pnpm workspace 的符号链接（`@ladle/react` store 路径）解析，
		// 那个位置在项目根之外，会被 Vite 的 fs allow-list 拦截（dev 直接 403）。
		// 查看页是本地组件浏览器，放宽 allow-list 即可；生产构建不受影响。
		fs: { strict: false },
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
