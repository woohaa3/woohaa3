import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 整仓 `pnpm -r run test` 会并行跑多个包；jsdom/React 用例在负载下偶发超过 5s，
    // 超时又会把后续用例级联成空 DOM。给真实渲染型用例留出余量。
    testTimeout: 15_000,
    // 浏览器侧的纯逻辑：选中映射、草稿、参考资产解析、任务提交协调、历史客户端/页面。
    // 需要 DOM 的组件测试用 `@vitest-environment jsdom` 指令；dom-setup 补齐 ResizeObserver
    // 等 jsdom 缺失的浏览器 API（change: adopt-radix-lucide-canvas-ui）。
    setupFiles: ["src/cordis/test-support/dom-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "acceptance/**/*.test.ts"]
  }
});
