import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 独立开发宿主（change: 2026-10-21-extract-photocraft-subproject，design D3/D6）。
 *
 * 它只依赖子项目包与浏览器 API：没有 Cordis、没有 Canvas 服务、没有 Woohaa backend。
 * 编辑器内核通过包 exports 的字面量子路径按需加载，与宿主构建走同一条 Vite 解析链。
 */
export default defineConfig({
  plugins: [react()],
  // 字体是子项目固定资源：dev 直接以 `assets/` 为 public 根，避免复制 8 MB 字体。
  publicDir: fileURLToPath(new URL("../assets", import.meta.url)),
  server: { port: 4318, strictPort: true },
  preview: { port: 4319, strictPort: true },
  build: { target: "es2022", sourcemap: true }
});
