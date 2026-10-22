import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 适配包与被 link 的核心包必须共用同一份 React；否则 hooks 读到 null dispatcher。
const react = fileURLToPath(new URL("../../node_modules/.pnpm/react@18.3.1/node_modules/react", import.meta.url));
const reactDom = fileURLToPath(new URL("../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom", import.meta.url));
// 干净副本没有构建 Rust 产物时也须能解析字面量子路径；这些用例自带内核替身。
const wasmStub = fileURLToPath(new URL("../../packages/editor/src/test-support/wasm-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: react },
      { find: /^react\/jsx-runtime$/, replacement: `${react}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${react}/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: reactDom },
      { find: /^react-dom\/client$/, replacement: `${reactDom}/client.js` },
      { find: /^react-dom\/test-utils$/, replacement: `${reactDom}/test-utils.js` },
      { find: /^@woohaa3\/photocraft-editor\/wasm$/, replacement: wasmStub }
    ]
  },
  test: {
    environment: "node",
    server: {
      deps: {
        // 核心包与 Radix 必须由 Vite 转换才能共用同一份 React；否则 hooks dispatcher 为 null。
        inline: ["@woohaa3/photocraft-editor", /@radix-ui\//]
      }
    },
    // 组件/交互用例用 `@vitest-environment jsdom`；本 setup 补齐 jsdom 缺失的浏览器 API。
    setupFiles: ["src/test-support/dom-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"]
  }
});
