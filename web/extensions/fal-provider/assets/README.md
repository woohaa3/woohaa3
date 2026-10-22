# fal-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：fal.ai 官网 <https://fal.ai/> 的 apple-touch 图标 `https://fal.ai/apple-touch-icon.png`（180×180 PNG，2026-10-16 取得）。

- 用途：fal.ai Provider 在设置页的卡片图标。
- 处理：文件按字节原样复制，像素未做修改。
- 归属：fal.ai 名称与图形归其所有者所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的 `icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。
