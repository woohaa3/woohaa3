# 实心图标（Font Awesome 6 Solid）

`icons.tsx` 里 `*SolidIcon` 系列（`LayerGroupSolidIcon` / `CubeSolidIcon` /
`FolderPlusSolidIcon` / `ImageSolidIcon` / `GoogleDriveSolidIcon` / `PinterestSolidIcon`）
的 SVG path 取自 Font Awesome，**构建期**从包里取出后内联为常量，运行时不依赖该包。

- 来源：<https://fontawesome.com>（`@fortawesome/free-solid-svg-icons`、
  `@fortawesome/free-brands-svg-icons`，v7.3.1）
- 取得日期：2026-11-01
- 授权：**CC BY 4.0**（<https://creativecommons.org/licenses/by/4.0/>）
- 作者：Font Awesome（Dave Gandy 等），图形未做修改，只把 `fill` 设为 `currentColor`
  以跟随主题

## 与四喜前端的关系

四喜桌面端（`src/components/icons.tsx`）同样使用 Font Awesome 6 Solid，署名方式见
该仓库的 `THIRD_PARTY_NOTICES.md`。宿主这里引入同一套图形，是为了让**画布左侧资源栏**
与四喜的侧边栏导航在图形语言上一致 —— Lucide 是线条风格，与 FA 的实心风格并排
一眼就能看出不是一套。

**只用于与四喜界面并排出现的位置**；宿主自己的其它界面继续用 Lucide allowlist，
两类图标不要混着用。

## 规格

| 图形 | 网格 | 用途 |
| --- | --- | --- |
| `layer-group` | 512×512 | 图层 |
| `cube` | 512×512 | 产品 |
| `folder-plus` | 512×512 | 项目商品 |
| `image` | 448×512 | 图片 |
| `google-drive`（brands） | 512×512 | Drive |
| `pinterest`（brands） | 512×512 | Pinterest |
