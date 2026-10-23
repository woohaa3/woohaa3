# 绘画域真实 WASM 验收套件

本目录把 U27–U36 的验收证据固化成**可复跑**的脚本，跑的是 `packages/editor/dist/wasm` 里
Rust 编译出的真实内核，不是 mock，也不是对 TS 编译结果的自证。目的是让集成负责人和验收人
不必重现一次对话，就能独立复现「参数编译 → WASM → 真实像素/结构」这条链。

## 运行

```bash
cd photocraft
node scripts/build-wasm.mjs                # 先构建真实内核（改了 Rust 就必须重跑）
node tests/features/painting/run.mjs       # 全部，14 个文件 / 164 条断言
node tests/features/painting/run.mjs u28   # 只跑文件名含 u28 的
node tests/features/painting/u31-pen-pose.mjs   # 单独跑某一个
```

退出码：全部通过 `0`，否则 `1`。任何一个文件失败都会让整体失败，不会被后面的成功掩盖。

产物（`.pcraft` / `.psd`）写到系统临时目录下的独立子目录，不污染仓库。

## 覆盖

| 文件 | 覆盖 | tasks |
| --- | --- | --- |
| `panel-commands.mjs` | 面板实际会发出的每条命令在真实内核上可执行（含参数形状） | 2.x 贯通 |
| `u27-tools.mjs` | 铅笔跟随前景色/硬边；颜色替换只改匹配色；两工具尺寸独立 | 2.1 |
| `u28-gradient-bucket.mjs` | 渐变端点/反向/插值方式/平滑度；桶填充选区与连通域 | 2.2 |
| `u29-erasers.mjs` | 魔术橡皮按区域；背景橡皮按取样色（含两种取样模式差异）；保护前景色 | 2.3 |
| `u30-dynamics.mjs` | 混合模式/纹理/颜色/形状/散布/压力曲线改变真实像素；预览不写文档；seed 可复现 | 2.4 |
| `u31-pen-pose.mjs` | 倾斜/旋转经槽位编码进入内核动态；槽位对齐；一步撤销（采集已接线，真笔记录待硬件） | 2.5 |
| `u32-brush-library.mjs` | 选区笔尖尺寸；分组改名/排序/删除/默认组保护；快照往返；删库不影响已提交像素 | 2.6 |
| `u33-symmetry.mjs` | 垂直/水平/双轴/对角镜像；一次撤销移除全部镜像；从路径定义；对称不改内容指纹 | 2.7 |
| `u34-eyedropper.mjs` | 点采样/平均采样/图层策略；图外与透明返回空；非法尺寸拒绝 | 2.8 |
| `u35-swatches-gradients.mjs` | 色板增改/移动/分组/ACO 往返/重置；渐变预设选择并用于绘画；偏好不推进修订 | 2.9 |
| `u36-tool-presets.mjs` | 预设保存/套用/过滤/改名/删除/快照；单工具与全部重置只改偏好 | 2.10 |
| `content-roundtrip.mjs` | 每个像素命令参战后的工程往返逐像素一致；偏好不进内容与工程字节；旧工程兼容 | 3.2 |
| `psd-cross-format.mjs` | PSD 矩阵声明、导出预检、导出/再导入尺寸一致 | 3.2 跨格式 |
| `cross-domain.mjs` | 绘画 × 选区裁剪 × 混合/不透明度 × 图层蒙版 × 分组 × 对称事务 × 撤销/重做 × 保存/重开身份 × 原生核验 × PSD 往返 | 5.2 |

## 边界（必须如实读）

这些脚本证明的是**已接线的域内实现与真实内核行为**，不代替下列仍需外部条件的验收：

- **真笔硬件**：`u31-pen-pose.mjs` 证明「采集到就能生效」；共享 `photo-editor-canvas.tsx` 现在
  用真实 `PointerEvent` 的 `tiltX/tiltY/twist` 填充姿态槽位，但**本机没有数位笔**，无法采集
  真实倾斜/旋转读数，需具备硬件的环境录一份记录。
- **真实 UI 与帧率**：需要真实 GPU 显示会话（本机 Linux 无 `renderD*`），见 change 的
  `verification.md` 的待人工验证项。
- **>512 笔刷**：卡在共享预算 `rust/project-limits.json` 的 `maxBrushSizeSourcePixels`，本域未改。

## 与单元测试的分工

`packages/editor/src/features/painting/*.test.ts(x)` 测参数编译、面板交互与门禁逻辑；
本目录测**内核真实行为**。两者不互相替代：前者不需要 WASM，后者不需要 DOM。
