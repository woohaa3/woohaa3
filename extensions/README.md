# 仓库根扩展根

本目录是 `extensions.config.json` 声明的**第二个扩展根**（第一个是 `web/extensions/`）。

- 每个扩展是这里的直接子目录，目录名不必等于 extensionId。
- 包名不以 `@woohaa3/extension-` 开头的目录不是扩展（扫描跳过），只用于随扩展根维护的共享库。
- 目录名以 `.` 开头表示**未安装**：不构建、不登记、不装配、不发布。
  已安装扩展的**启用/停用**不是改目录名，而是在插件面板开关里操作（运行中生效）。
- 扩展的编写、声明、发布与加载约定见 [`../web/extensions/README.md`](../web/extensions/README.md)。
- 品牌图形放在扩展包自己的 `assets/`（`extension.json` 的 `icon.asset`），不要直接往宿主
  `web/frontend/public/plugin-icons/` 里放文件——那里是 `pnpm -C web run icons:sync` 的生成物。
