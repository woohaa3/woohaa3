# runninghub-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：RunningHub 官网 <https://www.runninghub.ai/> 的站点图标 `https://www.runninghub.ai/favicon.ico?v=1.4`（ICO 内嵌的 256×256 32 位 PNG 帧，2026-10-16 取得）。

- 用途：RunningHub Provider 在设置页的卡片图标。
- 处理：ICO 里只有一个 256×256 PNG 帧，按字节原样取出，像素未做修改；该站另有 48×48 的 `/assets/images/logo.png`，分辨率不足未采用。
- 归属：RunningHub 名称与图形归其所有者所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的 `icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。
