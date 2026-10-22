# 应用插件目录

每个应用插件的前端、后端和共享定义放在 `web/extensions/<extensionId>/` 同一个目录下。

> 扩展根里还可以放**非插件**的共享框架包：包名不以 `@woohaa3/extension-` 开头（扫描按此规则跳过，
> 不会被当作扩展登记/装载），例如 Provider 插件公共能力 [provider-sdk](provider-sdk)、
> 存储实现共享工厂 [runtime-foundation](runtime-foundation)。它们属于框架侧，仍受规模/边界/纯粹性门禁约束。

```text
web/extensions/<extensionId>/
├── src/frontend/metadata.ts   # 纯浏览器 metadata（JSON 可序列化，唯一身份来源）
├── src/frontend/index.ts      # 浏览器实现入口；可达 descriptor
├── src/backend/index.ts       # 后端宿主入口
└── src/shared.ts              # 两端共用的身份与配置校验
```

较大的插件可以在该目录内增加 `frontend/`、`backend/` 子目录。插件实现不放进宿主目录；宿主只负责
加载、管理和测试插件。

片场（`film-set`）与游戏炼丹炉（`game-furnace`）采用职责在外、执行环境在内的组织方式；其它扩展无需同步迁移：

```text
src/state/{shared,browser,backend}        # 内容事实、纯规则、草稿和注入式快照存取
src/authoring/{shared,browser,backend}    # 编辑计划、提交、生成、录制与任务收尾
src/preview/{shared,browser,backend}      # 求值、播放、历史、固定构建试玩和会话
src/integration/{shared,browser,backend}  # 宿主协议适配、注册、权限与生命周期装配
```

环境子目录按需建立。依赖方向是 integration → authoring / preview → state；state 不依赖另外三类，authoring 与 preview 通过注入的窄端口协作。shared 不引用 browser/backend，也不接入 React、宿主服务或 Node I/O；browser/backend 不互相引用。contracts 中已有的公共 schema、codec 与 reducer 仍是唯一事实源。

`frontend/index.ts`、`frontend/metadata.ts` 与 package exports 的既有公共路径保持稳定，门面仅转出或委托。metadata 是独立构建的固定发现入口，可转出 integration 中的纯 metadata，不能可达 activation。内部直接导入职责叶子，不绕回公共聚合门面。两包测试使用 [AST 依赖扫描](../tooling/extension-dependencies.ts) 校验实际解析目标、类型/动态导入、重导出、环境闭包与循环。

页面 integration 持有 slots、输入 owner、焦点/删除观察与活动镜像，退出时幂等释放，部分装配失败逆序回滚。编辑会话管理字段草稿，preview 管理时钟、缓存和短期 token；目标或版本切换时隔离迟到回调。authoring 管理取消、重试与后台收尾，关闭工作区不取消宿主工作租约。片场仍经权威画布命令提交；炼丹炉仍先保存不可变 Media 快照，再确认节点稳定关联，不新增持久状态源。

## 声明面：`extension.json`

宿主只通过扩展目录里的 `extension.json` 认识一个扩展；新增/修改扩展不需要改框架源码（门禁见
[extension-purity.test.ts](../tooling/extension-purity.test.ts)）。可声明的内容：

| 字段 | 作用 |
| --- | --- |
| `backend` | 站点插件宿主的后端定义工厂（宿主核心站点插件走静态可信清单时才需要）。声明的导出必须真的存在，否则 `pnpm extensions:check` 失败 |
| `hostPlugin` | 插件树扩展层的 Cordis 插件：`provider`（向 `ctx.generation` 注册）或 `storage`（向 `ctx.storage` 注册）；声明模块、工厂、顺序与是否可选 |
| `canvasContent` | 画布内容端口：工厂返回 `CanvasContentRuntime`（可选分组 `frames` 预览/历史帧、`conversion` 转片场服务构造、`mcp` 片场 MCP 能力面），宿主装配 canvas-service 时注入；canvas-service 不 import 扩展实现。与 `hostPlugin` 不同，它不参与插件树 |
| `metadata` | 设置面元数据导出（`/api/settings` 的插件卡片用它） |
| `site` | 站点目录条目（名称、描述、能力、默认启停） |
| `publicRoutes` | 固定公开路径映射（`publicPath` 或包内导出 `publicPathExport`） |
| `bootstrap` | 槽位实现声明（storage / identity / access）；只允许内建根 |
| `required` | 发布装配的必需扩展：缺它的产物就在指针切换前失败（由装配器按扫描汇总，不再写死 id 清单） |
| `icon` | 插件图标，二选一：品牌图形 `{ "asset": "./assets/icon.png" }`（包内相对路径，宿主按约定注入 `/plugin-icons/<extensionId><ext>`，生成物由 `pnpm -C web run icons:sync` 同步）；语义图形 `{ "glyph": "migration" }`（`PLUGIN_ICON_NAMES` 里的名字，给没有浏览器前端的后端扩展用） |

Provider 插件用 `HostExtensionPlugin.modelRefresh` 声明设置弹窗插件详情里的「可用模型」一节（路径由插件自己用
`ctx.gateway.route` 注册并鉴权）；插件源码 MUST NOT 写死宿主静态目录里的品牌图形路径。

## 前端入口与 metadata

- **唯一身份来源**是 `src/frontend/metadata.ts`：只导出 JSON 可序列化的
  `ExtensionFrontendMetadata`（`extensionId`、`version`、`label`、`description`、`activation`、
  `configScope`、`required`、`sdkAbi`；可选 `settingsPanel`、`icon`）。`icon` 是
  `PLUGIN_ICON_NAMES` 里的语义名，浏览器侧的插件清单与设置卡片用它；品牌图形由 `extension.json`
  的 `icon.asset` 在构建时注入，不要在 metadata 里写死路径。它 MUST NOT 引用 plugin/UI/CSS/业务 store 或后端代码。
- `src/frontend/index.ts` 导出 `descriptor`（`ExtensionFrontendDescriptor`），其身份字段**复用**
  metadata（`{ ...METADATA, plugin: () => ... }`），避免重复维护 activation/required。
- `descriptor.plugin()` 是**无副作用工厂**，只有宿主请求装配时才构造完整 Cordis plugin。

### 设置面板（settingsPanel / settingsPlugin）

`settingsPanel: true` 表示扩展前端自带设置面板：画布内设置弹窗会**按需加载**该扩展前端（其余扩展仍
不加载），扩展在 `settings.plugin-config` slot 注册 `{ pluginId, render }`，设置按 `pluginId` 把面板
挂进「插件配置」的对应插件详情。画布里的 Provider 凭据弹窗仍可用同一份面板注册到
`provider-credentials.top`；插件未运行时设置只提示先启用，不渲染会调后端的面板。

扩展**未激活**时，宿主只调用 descriptor 的可选设置专用工厂，不会执行完整业务 plugin：

```ts
export const descriptor: ExtensionFrontendDescriptor = {
  ...METADATA,                      // 含 settingsPanel: true
  plugin: () => myExtension(),      // 完整业务入口（生成/画布事件/服务）
  settingsPlugin: () => mySettingsExtension() // 只注册 settings.plugin-config
};
```

约束（change: 2026-10-17-move-settings-into-canvas-dialog）：

- `settingsPlugin()` MUST 无副作用、只装配设置贡献，MUST NOT 启动生成入口、画布事件、授权/业务
  轮询或任务执行；
- 没有该入口的旧 artifact 只复用已存在的贡献，宿主不会回退执行 `plugin()`；
- 面板 props 是**有界**的：`requestClose` 在设置语境表示「返回插件列表」（经同一草稿门禁），
  `reportEditState({ dirty, pending })` 把异步动作计入设置的退出保护；
- 关闭设置只释放设置专用 fiber，不释放仍服务画布的扩展。

### activation / configScope 规则

| activation | configScope | 启动行为 | 失败语义 |
| --- | --- | --- | --- |
| `always` | `site` | Canvas 启动时与 required 一起**同步准备**（ChatGPT、片场） | required 失败 → 页面进入稳定错误，不挂载半可用画布 |
| `server-active` | `site` | 只登记 metadata；由服务端权威 active 状态驱动 reconciler 装配/释放（game-furnace、runninghub-provider） | 隔离失败、可重试；不影响核心画布 |
| `browser-local` | `browser-local` | 由当前 origin 的本地偏好决定是否加入启动清单（prompt-snippets、task-activity） | optional 失败隔离，不影响 required |
| `browser-local` + `required` | — | **非法组合**，装配前报错 | — |

## 独立 browser build

每个扩展有独立 `browser-dist/`（`pnpm --filter @woohaa3/extension-<id> run build:browser`，
或一次性 `pnpm run build:browser`）。宿主构建（`web/frontend` 的 Vite）**不再扫描或编译**扩展源码；
它只产出宿主模板，扩展由发布目录在运行时加载。

- 构建产物：薄 ESM 入口（`entry-<hash>.js`，导出 `extensionMetadata` 与
  `loadExtension(bindings)`）、实现/私有 chunk、完整样式（`styles-*.css`）、
  `metadata.json` 与 `artifact-manifest.json`。
- **薄入口**只静态依赖私有 runtime-binding 与内联 metadata；`bindRuntime(bindings)` 完成后才
  动态 import 实现，返回 `{ descriptor }`。因此绑定完成前不会求值任何扩展实现代码。
- `artifact-manifest.json` 记录 schemaVersion、metadata、protocolVersion、SDK ABI/React major、
  `requiredSdkGroups`/`requiredSdkExports`、入口/样式相对路径、文件 SHA-256/大小/raw+gzip 与真实
  import 图。`artifactId` 由全部输出内容与规范化 metadata/ABI 确定性计算（不含时间/绝对路径）。
- 约束：React / `react/jsx-runtime` / `@woohaa3/frontend/extension-api` 经生成 shim 解析为宿主
  runtime 绑定（**不内联第二份实现**）；`@deepseek-ai/cordis` 只允许 type-only；node builtin、
  后端 SDK、宿主私有路径、其他扩展源码、未解析 bare/CSS import、`eval`/`new Function` 一律拒绝。
- 扩展私有 dynamic import（如 `mediabunny`）保持独立异步 chunk。

## SDK 导入

扩展只依赖公共入口：

- `@woohaa3/contracts`：纯类型/常量（browser-safe 部分按需 tree-shake 进产物）。
- `@woohaa3/frontend/extension-api`：公共 Context/plugin 定义、组件与 model/authoring 能力。
- `@woohaa3/provider-sdk`（仅后端 Provider 插件）：出网守卫、设置弹窗「可用模型」刷新路由、外部 URL 的 SSRF 校验。
  守卫与鉴权不再由各 Provider 复制一份，插件只写自己的协议差异。

**必须使用具名导入**（`import { Button, ExecutionPanel, defineExtensionPlugin } from ...`）：
namespace（`import * as`）与 default（`import x`）运行时导入首期**拒绝**；`import type` 与具名
`type X` 不形成运行时需求。同名导出若来自不同 SDK 分组，会在 `requiredSdkExports` 中记录为
`{ group, name }`；builder 用 TypeScript AST 收集需求（不用文本正则，避免文档注释误判）。

## 发布与加载

- `pnpm run assemble:extensions`（`scripts/assemble-extension-release.mjs`）**只组合已编译产物**，
  把不可变 artifact 复制到 `/extensions/<id>/<artifactId>/...`，生成
  `/extension-releases/<releaseId>.json`，并把 `<link rel="woohaa-extension-release">` 写入
  `index.html`。缺 artifact 的扩展需 `--allow-missing` 显式忽略；否则装配前报错。
- 运行时 `ExtensionRuntimeService`（App 级单例）读取该 link、固定 release、按需加载实现；成功的
  module/CSS 跨页面复用，业务实例不缓存。未选择/禁用的入口**不产生任何 JS/CSS/SDK 请求**；
  Task History 冷启动不触发任何 Canvas 扩展请求。
- 站点插件发布时先 `build:browser` 再 `assemble:extensions`；`pnpm build` 已串联两步。

## 画布目录条目动作（`canvas.catalog-item-action`）

画布切换器为每个目录条目渲染该 slot 的贡献，props 为 `{ entry, openCanvas, refreshCatalog }`：

- `entry` 是 `CanvasSummary`，带 `sources`（`local` / `remote`）与 `sync`（`local-only` / `synced` /
  `syncing` / `offline` / `failed` / `remote-only`），贡献方据此自行决定在哪些条目上呈现；
- `openCanvas(canvasId)` 切到该画布（需要真正开始推内容时用它，例如同步远端）；
- `refreshCatalog()` 刷新目录（动作成功后调用，来源与同步徽标随之更新）。

宿主只做通用渲染，不认识具体扩展、不按扩展 ID 分支；贡献必须在 `ctx.effect` 中注销。示例是
remote-server 的「同步远端」：只在已连接且条目为「仅本机」时显示，点击后显式启用这张画布的
远端同步——登录远端本身不是上传的默认行为。

## 兼容更新

仅修改某扩展 UI/CSS 时，重新 `build:browser` 该扩展并 `assemble:extensions` 即可：只有它的
`artifactId` 变化，其余 artifact 与宿主全部 JS/CSS hash 不变，`index.html` 的发布 link 指向新
release。旧 release 与旧 artifact 保留在发布目录，供已打开页面继续加载（回滚窗口）。

## 示例

`extensions/oauth-agent` 是完整样例（原 `chatgpt`，change: 2026-10-17-add-agent-appserver-and-sdk-connections 改名）：
`src/frontend/metadata.ts` 声明 `activation: "always"`、
`required: true`、`settingsPanel: true`；`index.ts` 导出复用 metadata 的 `descriptor`（含设置专用 `settingsPlugin`）；`plugin.tsx` 用
`defineExtensionPlugin` 在自身 scope 注入 `slots`/`applicationRemote`、`provide` 业务 service、
贡献 `provider-credentials.top` 授权行、`settings.plugin-config` 设置面板与 `authoring.generate` 来源（面板由宿主内置渲染），并在 dispose 时按 owner 释放。

`sample-site-extension` 是仅供测试使用的样例：其前端只验证进入/释放生命周期；生产发布发现
不登记测试 fixture（其入口不是约定 browser 入口，且无 `browser-dist` artifact）。
