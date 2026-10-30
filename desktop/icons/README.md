# WooHaa3 桌面图标

用于 macOS Dock 与 Tauri 应用包。图形是品牌主 Logo 左侧的等距微缩场景（建筑、人物、植物）加上方悬浮的平面 UI 卡片，透明底、主体填满图标区域，呼应画布式多媒体创作工作台。

- 图片模型：`gpt-image-2`（该编辑任务在 sunburst 上返回 404，改用 `gpt-image-2`），通过本项目已配置的 LiteLLM Provider 网关调用 OpenAI Images 兼容接口。
- 调用方式：imagegen 技能的 `scripts/image_gen.py` CLI；1024×1024、`quality=high`。
- 完整生成提示词：[generation-prompt.txt](generation-prompt.txt)；规格与主 Logo 见 `docs/brand/`。凭据从本机设置读取，不随素材保存。
- [source.png](source.png)：1024×1024 RGBA 图标母版，由主 Logo 编辑得到（去字标、透明底、放大主体填满画面）。
- `icon.icns` / 各尺寸 PNG / `icon.ico`：由 `pnpm desktop:icons` 从源图生成。该命令会用 Tauri CLI 输出 Android/iOS 与 Windows Store 图标，脚本随后清理，只保留桌面所需文件。

替换源图后运行：

```sh
pnpm desktop:icons
```

发行包使用 `desktop/tauri.conf.json` 的 `bundle.icon`。`pnpm dev:desktop` 与 ATC 的「打开 Tauri」
在创建开发 `.app` 时也会复制 `icon.icns` 并声明 `CFBundleIconFile`。已有开发应用需重新打开以刷新系统图标。

生成图与各尺寸资产可做静态检查；真实 Dock 显示及系统图标缓存刷新效果待人工验证。
