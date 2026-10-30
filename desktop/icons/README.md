# WooHaa3 桌面图标

用于 macOS Dock 与 Tauri 应用包。图形是品牌主 Logo 左侧的严格等轴测微缩模型（1 栋平屋顶主楼、1 个附属体块、2 棵圆冠树、1 个胶囊小人、等轴菱形浮岛）加上方两张平面 UI 卡片，透明底、主体铺满图标区域。

- 两种颜色，模型和卡片各自同时使用，且不含黑白：翡翠绿 `#16846c`（明暗 `#2a9a80` / `#12755f`）与浅米黄 `#fdf8ee`（明暗 `#fffcf7` / `#efe3d0`）。
- 模型：浅米黄墙面、附属体块、女儿墙压边、浮岛顶面与树干；绿色屋顶、屋顶小体块、窗洞、树冠与小人。
- 卡片：浅米黄卡面 + 绿色边框与占位条，两张卡片之间用一条贝塞尔曲线相连，不连向模型。
- 几何是硬约束：正交等轴，向右上 30° 与向左上 30° 两根轴镜像对称，浮岛为等轴菱形，建筑两个可见墙面等宽。
- 图片模型：`gpt-image-2`，通过本项目已配置的 LiteLLM Provider 网关调用 OpenAI Images 兼容接口。`gpt-image-2.5-sunburst` 当时上游 deployment 处于 cooldown / 404，未能使用。
- 调用方式：imagegen 技能的 `scripts/image_gen.py` CLI；1024×1024、`quality=high`。
- 完整生成提示词：[generation-prompt.txt](generation-prompt.txt)；规格与主 Logo 见 `docs/brand/`。凭据从本机设置读取，不随素材保存。
- [source.png](source.png)：1024×1024 RGBA 图标母版，按图标尺寸独立生成后抠掉洋红键色底得到（不是裁切主稿）。
- `icon.icns` / 各尺寸 PNG / `icon.ico`：由 `pnpm desktop:icons` 从源图生成。该命令会用 Tauri CLI 输出 Android/iOS 与 Windows Store 图标，脚本随后清理，只保留桌面所需文件。

替换源图后运行：

```sh
pnpm desktop:icons
```

发行包使用 `desktop/tauri.conf.json` 的 `bundle.icon`。`pnpm dev:desktop` 与 ATC 的「打开 Tauri」
在创建开发 `.app` 时也会复制 `icon.icns` 并声明 `CFBundleIconFile`。已有开发应用需重新打开以刷新系统图标。

生成图与各尺寸资产可做静态检查；真实 Dock 显示及系统图标缓存刷新效果待人工验证。
