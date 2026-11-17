# CHANGELOG

## 1.0.1

- 2026-11-13 `1.0.1`（上一版 `1.0.0`）：feat(extensions): 扩展发版版本治理

## 1.0.2

- 2026-11-16 `1.0.2`（上一版 `1.0.1`）：fix(credentials): 让换 API Key 立即重建执行实例（credentialEpoch 参与 registry 签名）

## 1.1.0

- 2026-11-16 `1.1.0`（上一版 `1.0.2`）：按《图片生成 API》文档补齐图片能力
  - fix：4.5 / 4.0 不再无条件下发 `output_format`——上游对这两个版本连 `jpeg` 也拒，此前每次生成都 400
  - fix：官方像素表改为按版本族分组；5.5 / 5.0 pro / flash 的 2K 16:9 是 2816x1584，lite / 4.5 是 2848x1600，此前共用一张表导致选固定比例时像素值错误
  - feat：新增 Seedream 5.5（`doubao-seedream-5-5-261028`），支持文生图原生 RGBA、图层拆分 `max_images`（2–100）与文字图层 OCR
  - feat：4.0 补上官方比例表（1K 为 4.0 专属：16:9 = 1280x720）
  - feat：按版本放行提示词优化模式（`fast` 仅 5.0 pro / 4.0）、联网搜索与流式输出，不再一律放行导致上游 400
  - feat：不支持 `output_format` 的版本不再展示「输出格式」控件

- 2026-11-16 `1.1.0`（上一版 `1.0.2`）：fix(contracts): 声明 sideEffects:false 恢复扩展产物 tree-shaking

## 1.1.1

- 2026-11-16 `1.1.1`（上一版 `1.1.0`）：修复「所有模型都显示不可执行」
  - fix：推理接入点（`ep-`）不再是可执行门槛。方舟允许直接用公开 Model ID 调用，此前未填接入点的模型全部标为不可执行，且执行层还会抛「未配置推理接入点」，即使 UI 放行也调不通
  - fix：`applyEndpoint` 在未配接入点时回退到目录 Model ID，而不是报错
  - fix：健康检查只把「未配 API Key」与「接入点格式非法」当作降级原因

- 2026-11-16 `1.1.1`（上一版 `1.1.0`）：fix(contracts): 声明 sideEffects:false 恢复扩展产物 tree-shaking

## 1.1.2

- 2026-11-16 `1.1.2`（上一版 `1.1.1`）：fix(layer-decomposition): 图层拆分不再下发 `background`
  - fix：上游实测 `background` 与 `layer_decomposition` 互斥（`The parameter background ... is not supported with layer_decomposition`，400），拆分开启时整个字段不下发，此前带 `background: transparent` 的请求必然失败
  - fix：图层拆分开启时隐藏「背景」控件，不再摆一个注定报错的选项；旧草稿里残留的 `background` 也不会触发报错
