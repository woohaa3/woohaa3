import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 适配包与被 link 的核心包必须共用同一份 React；否则 hooks 读到 null dispatcher。
//
// 用 Node 解析（以核心包为锚点）而不是拼 `.pnpm/react@18.3.1/...` 的固定路径：`node_modules`
// 布局取决于安装方式（本地虚拟存储、全局虚拟存储、hoisted），写死路径在换环境后指向不存在的
// 目录，28 个组件用例会以 "Cannot find module react/jsx-dev-runtime" 假失败。
const editorDir = fileURLToPath(new URL("../../packages/editor/package.json", import.meta.url));
const resolveFromEditor = createRequire(editorDir);
const packageDir = (id: string) => path.dirname(resolveFromEditor.resolve(`${id}/package.json`));
const react = packageDir("react");
const reactDom = packageDir("react-dom");
// 干净副本没有构建 Rust 产物时也须能解析字面量子路径；这些用例自带内核替身。
const wasmStub = fileURLToPath(new URL("../../packages/editor/src/test-support/wasm-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: react },
      { find: /^react\/jsx-runtime$/, replacement: path.join(react, "jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(react, "jsx-dev-runtime.js") },
      { find: /^react-dom$/, replacement: reactDom },
      { find: /^react-dom\/client$/, replacement: path.join(reactDom, "client.js") },
      { find: /^react-dom\/test-utils$/, replacement: path.join(reactDom, "test-utils.js") },
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
