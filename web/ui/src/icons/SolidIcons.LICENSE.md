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

## `PhotoshopIcon`（例外）

`PhotoshopIcon` 不走 Font Awesome：它的路径是**用 fontkit 从系统字体轮廓生成**的
（`C:/Windows/Fonts/segoeuib.ttf`，Segoe UI Bold 的 `P` 与 `s` 两个字形），再合成进
512×512 的圆角方框。生成日期 2026-11-06。

- 它是**非矩形网格字形**：字母从方框里挖空，因此必须 `fill-rule="evenodd"`。
  `makeSolidIcon` 为此多了一个可选的第 4 个参数（其余实心图标仍是 `nonzero`，行为不变）。
  用 `nonzero` 渲染会得到一个实心方块 —— 已在 16px 实际尺寸下渲染核对过。
- 只用于节点操作横条的「去P图」入口，属于品牌字形，已在 `CUSTOM_ICON_EXCEPTIONS` 登记。
- **重新生成时**：改 `build.cjs` 里的字体或 `TARGET_W`，输出必须是 `evenodd`。
  改完务必把图标按 16px 渲染出来看一眼，路径正确与否肉眼看图才知道（单测只能断言 SVG 存在）。
