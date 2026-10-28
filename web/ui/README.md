# @woohaa3/ui

公开客户端共享的浏览器展示层。组件的唯一实现位于此包；Cordis、Canvas、任务、配置写入、授权、媒体 URL 解析和 Dialog stack 由调用方持有。

```tsx
import { Button, UiProvider } from "@woohaa3/ui/primitives";
import { ThemeProvider, type ThemeSource } from "@woohaa3/ui/theme";
import "@woohaa3/ui/styles.css";

export function Example({ theme }: { theme: ThemeSource }) {
  return <ThemeProvider service={theme}><UiProvider>
    <Button onClick={() => console.info("clicked")}>操作</Button>
  </UiProvider></ThemeProvider>;
}
```

允许入口：根入口、`primitives`、`forms`、`dialogs`、`media`、`settings`、`assistant`、`feedback`、`icons`、`theme` 与显式 `styles.css`。使用具名导入；私有文件路径不构成公共 API。React/ReactDOM 是 peer，TypeScript 消费者同时提供可选 peer `@types/react`/`@types/react-dom`，Radix/Lucide 仅由此包声明。CSS sideEffects 保证样式不被裁剪。`@woohaa3/contracts/theme` 只提供纯 token/schema 类型，不依赖应用服务或 contracts 根入口的旧业务兼容导出。

ThemeSource 的 subscribe/getSnapshot/applyTo 连接宿主唯一主题 owner；宿主负责完整验证与选择持久化，Provider 负责释放订阅和根绑定。Dialog/AlertDialog/MediaDialog 接收受控实例与回调，不创建隐式 Host。CopyField 与 AudioPlayer 隔离换值/换源后的旧异步结果。

普通 Web 消费者显式导入公共样式；frontend 在启动 CSS 中先加载公共样式，再加载宿主覆盖，扩展通过 SDK adapter 共享同一 React/Context。扩展不得直接导入 CSS 或内联此包。旧 extension-api 的公开导出仅作同实例兼容。业务组件不从 UI 反向导出。

`pnpm typecheck` / `pnpm test` / `pnpm build`。构建生成 ESM 与声明，并打包只使用公共入口、未导入 frontend/index.css 的 `fixtures/standalone.tsx`；metafile 拒绝应用/展示依赖。workspace 源码入口用于 Vite 与扩展 AST 校验，dist 是验证产物。源码与声明边界门禁位于 `web/tooling/shared-ui-boundary.test.ts`。

包内 `.stories.tsx`、`test-support`、Ladle 和测试 setup 仅用于开发，不能进入生产闭包。Ladle 由同包的 `showcase/` 子包（独立 workspace 包 `@woohaa3/ui-showcase`）装配；组件故事不依赖应用 CSS，业务组合故事由该子包提供。生成主题样式由 `client/scripts/generate-theme-tokens.mjs` 拥有，禁止手改。
