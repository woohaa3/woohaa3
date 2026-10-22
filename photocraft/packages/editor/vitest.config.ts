import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 干净副本未构建 Rust 时也要能解析字面量子路径；测试注入自己的内核替身。
      "@woohaa3/photocraft-editor/wasm": fileURLToPath(new URL("./src/test-support/wasm-stub.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    // 需要 DOM 的组件测试用 `@vitest-environment jsdom` 指令；本 setup 补齐 jsdom 缺失的
    // ResizeObserver/DOMRect 等 Radix 依赖。
    setupFiles: ["src/test-support/dom-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"]
  }
});
