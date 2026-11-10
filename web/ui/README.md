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

生成配置从 `@woohaa3/ui/assistant` 导入 `GenerationModelDirectory`、`GenerationParameters`、`ReasoningParameters`。目录接收公开的 `GenerationModelEntry` / `GenerationSourceEntry`，业务 owner 将来源、真实模型和可用性原子投影；UI 不请求目录或推理。来源点击只是浏览，具体模型点击才 `onSelect(entry)` 并关闭，默认模型用 `isDefault` 与空 modelIdentity 保持请求省略语义。`loading/error/onRetryAll` 表达来源读取失败，source.status 表达局部不完整，`onRetry(sourceIdentity)` 仅重读该来源。recent 只传真实受理过的公开 identity。

参数接收原 schema 投影后的字段、当前 parameters 与 `onChange(patch)`；连续修改保持展开，owner 负责写入草稿 / 历史并在提交前校验。元数据 `x-pptask-presentation` 由 contracts 定义，非法成员局部忽略；旧字段默认高级，必填缺值和错误提升可见。`onReset` 可接原业务重置，否则仅恢复字段默认值；提示词与参考不在该字段集合。思考强度 options 必须来自当前模型，空值表示请求省略。旧 `AssistantModelSelector.variant` 仅保留源码兼容，已不呈现；消费者应迁移到独立 `ReasoningParameters`。

目录宽 608px，参数宽 400px，使用公共 Popover 碰撞避让与内部滚动，支持电脑和 Pad。所有样式随公共 styles.css 导出，示例故事只验证展示，不能代替真实应用业务验收。
