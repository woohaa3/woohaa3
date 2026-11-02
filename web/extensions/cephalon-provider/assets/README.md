# cephalon-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：端脑云站点图标 <https://cephalon.cloud/favorite.ico>（原始为 1400×1400 PNG，2026-11-02 取得）。平台站点与其文档站使用同一枚端脑云标志。

- 用途：Cephalon Provider 在设置页的卡片图标。
- 处理：用 ImageMagick `convert -resize 300x300` 缩放到 300×300 PNG，未做其它改动。
- 归属：端脑云（Cephalon Cloud）名称及图形归其所有者所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的 `icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。
