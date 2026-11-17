# CHANGELOG

## 0.1.1

- 2026-11-13 `0.1.1`（上一版 `0.1.0`）：feat(extensions): 扩展发版版本治理

## 0.1.2

- 2026-11-17 `0.1.2`（上一版 `0.1.1`）：fix(hosting): 临时图床不再按有效窗口排除来源
  - 移除 `validitySeconds` 声明与 900 秒硬拒绝；标准参考输入仍照常参与自动与手动选择

## 0.1.3

- 2026-11-17 `0.1.3`（上一版 `0.1.2`）：fix(reference): 临时图床回退地址可被模板参考接受
  - `/media/upload` 成功地址写入参考上传允许名单，`/tasks/upload` 失败后不再报「参考素材上传失败」

## 0.1.4

- 2026-11-17 `0.1.4`（上一版 `0.1.3`）：refactor(upload): 参考素材上传只走 `/media/upload`
  - 删除 `/tasks/upload`、`X-Tenant-ID`、provider/filename、32 MiB 与 `SDPPPX_UPLOAD_PROVIDER` 旧逻辑
  - 模板参考上传与临时图床共用 `media-upload.ts` 适配器、20 MiB 限制与允许名单

## 0.1.5

- 2026-11-17 `0.1.5`（上一版 `0.1.4`）：fix(panel): 模板模型不再渲染 rawParams 与提示词输入框
  - 未识别字段只记诊断；提示词由画布上游文字节点解析
  - `promptRequirement` 固定为 `none`，有 prompt 字段时仍写回 payload

## 0.1.6

- 2026-11-17 `0.1.6`（上一版 `0.1.5`）：fix(panel): 识别带前缀的模板提示词字段，参数默认进入常用区
  - `2_prompt` 等模板提示词字段不再显示为参数输入框
  - 模板字段不再全部收进「高级参数」
