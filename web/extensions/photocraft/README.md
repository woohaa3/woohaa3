# PhotoCraft 扩展

PhotoCraft 的浏览器与后端接入源码。完整工作区在本目录的上一级
（`marketplace/extensions/photocraft/`）：`protocol`（纯协议）、`project-verifier`（Node 工程核验）、
`web`（官方 egui/WASM 编辑器与宿主适配）、`extension`（本包：声明、前端入口、后端工厂）。

工作区不复制宿主代码，但构建复用公开 client 仓的脚本与 SDK 类型。默认约定 `client` 与
`marketplace` 是**同级目录**（父仓里它们是两个子模块）；换位置时设置 `PHOTOCRAFT_FONT_DIR` 并调整
`package.json` 的 `link:` 路径。

## 构建

在父仓根目录（或同时检出 `client` 与 `marketplace` 的目录）执行：

```sh
pnpm -C marketplace/extensions/photocraft install --ignore-scripts
pnpm -C marketplace/extensions/photocraft/web test
pnpm -C marketplace/extensions/photocraft/web typecheck
pnpm -C marketplace/extensions/photocraft build:extension
pnpm -C marketplace/extensions/photocraft/extension test
```

首次构建需要 Rust/WASM 工具链，从固定上游和完整补丁生成官方 app；之后按补丁摘要复用缓存。
WASM 预算由扩展构建检查（raw 30 MB / gzip 13 MB）。构建同时把公开客户端的中文字体
（`NotoSansSC-Regular.otf`）、清单与 OFL 许可证复制进 `browser-dist/assets/photocraft/fonts/`，
产物不依赖父仓源码；字体按需下载，不计入 WASM 体积。源码和生成物边界见
[web/README.md](../web/README.md)。

构建产出：

| 产物 | 用途 |
| --- | --- |
| `extension/browser-dist/` | 浏览器 artifact（宿主发布目录与开发者模式重登记） |
| `extension/dist/backend.js` | 宿主插件工厂 `createPhotocraftPlugin`（`hostPlugin`） |
| `marketplace/.local/photocraft/` | 本地预构建安装单元（`build-extension.mjs`，不入库） |

可用 `--outdir <目录>` 改变预构建输出位置。公开客户端不再内置本扩展；本地安装单元只用于
`WOOHAA3_EXTENSION_DIRS` 或手工验证。源码工作区不在扩展扫描根，父子仓不会重复登记。

## 开发者模式热重载

宿主只监听**产物**，构建留在作者侧。前端迭代：

```sh
# 终端 A：改 src/frontend 或 web/src 后增量重建 browser-dist
node client/web/scripts/build-extension-browser.mjs \
  --cwd marketplace/extensions/photocraft/extension --watch

# 终端 B：宿主登记同一目录，并启用开发者模式
pnpm dev --dev-source marketplace/extensions/photocraft/extension
```

`browser-dist/` 变化后，宿主重新登记 artifact 并**原地重装扩展实例**：不刷新页面、不重建画布
scope、不重启宿主。开发者目录不签名、不写 `installations.json`、优先级高于受管版本。

**后端当前仍需重启**：本扩展声明的是 `hostPlugin`，扫描器把它记为 `hotSwappable`，但「热切换」只覆盖重新装配前端贡献；`dist/backend.js`（含 `project-verifier`、`protocol` 的内联代码）变化不会换掉已激活的宿主插件。改后端源码（`extension/src/backend.ts`、`project-verifier`、`protocol`）后重启宿主。

## 打包与发布

市场包用客户端打包脚本生成（会重新做标准 `backend-dist/` 单文件构建与受管预检）：

```sh
node client/scripts/pack-extension.mjs marketplace/extensions/photocraft/extension \
  --key <ed25519私钥.pem> \
  --out photocraft-0.1.3.wxt
```

资产名必须是 `photocraft-<version>.wxt`，发布到本仓库的 GitHub Release；客户端
`github-release` 来源按摘要、签名、受管预检安装。本扩展走 `hostPlugin`，安装后可热装载；站点
首次启用需要提交一次空配置（`configVersion`），状态才会从 `configuring` 变为 `active`。

## 运行时边界

手动安装预构建包时，将 tgz 解压至任一扩展根的 `photocraft/` 子目录（去掉 tar 中的 `package/` 前缀），
并通过 `WOOHAA3_EXTENSION_DIRS` 显式提供扩展根。发布包自带 `backend-dist/entry.mjs`、`browser-dist/`、声明和
许可证，不需要安装运行时依赖，也不需要工作区源码。停用扩展将移除普通页面贡献和工程格式提供者；
已有本地文档仅保留下载/关闭的恢复界面，最后一份关闭后释放 owner。公开客户端不再内置本扩展：
从市场安装，或用 `WOOHAA3_EXTENSION_DIRS` 指向本地安装单元后，按插件开关启停。

后端默认使用有界进程内核验。可选环境变量 `WOOHAA3_PROJECT_VERIFIER_PATH` 只由本扩展读取，必须为
原生核验工具的绝对可执行路径；包含嵌入智能对象的工程仍要求原生全树核验。当前聚焦编辑应用结果是
PNG，不上传工程。

原生工具不随本包提供。真实输入、透明混合、网格跟随与帧率需在真实 GPU 上验收。

前端直接挂载官方 canvas，不使用 iframe。文档在当前应用窗口跨节点、跨画布和页面驻留；返回仅隐藏，
应用到节点与关闭标签分开。刷新、关窗或重启不恢复未保存的工程，也不弹离开提示。
