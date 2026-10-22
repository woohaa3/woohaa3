# grsai-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：grsai 官网 <https://grsai.ai/> 首页引用的站点标志 `https://grsai.ai/images/logo.png`（1024×1024 PNG，2026-10-16 取得）。该站站点图标 `/favicon.ico` 只有 64×64，未采用。

- 用途：grsai Provider 在设置页的卡片图标。
- 处理：文件按字节原样复制，像素未做修改。
- 归属：Grsai 名称与图形归其所有者所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的 `icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。
