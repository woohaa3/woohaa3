# 插件品牌图形（生成物）

这个目录由 `scripts/lib/extension-icon-assets.mjs` 从各扩展包内的品牌图形**同步生成**，不要手工编辑。

- 事实来源：扩展目录里的 `extension.json` → `icon.asset`（例如 `web/extensions/ark-provider/assets/icon.png`）。
- 逻辑路径约定：`/plugin-icons/<extensionId><扩展名>`，由宿主注入到后端插件卡片与浏览器 metadata。
- 新增/更换图形：把文件放进扩展包的 `assets/`，在 `extension.json` 里声明，然后跑
  `pnpm -C web run icons:sync`（或任意一次构建）；`pnpm extensions:check` 会校验这里的漂移。

图形只用于在设置页标识对应的产品或服务（指名性使用），不代表与该项目的合作、赞助或背书关系；
来源与许可记录在各扩展包的 `assets/README.md`。
