# bailian-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

百炼（Model Studio）控制台实际使用的 64×64 位图是
`https://img.alicdn.com/imgextra/i1/O1CN01Es0c28049TL083Vo_!!6000000002263-2-tps-64-64.png`，
尺寸太小不适合做卡片图标（同族的 `-tps-96`～`-tps-512` 变体均 404）。因此取同一标识的矢量重绘
`https://unpkg.com/@lobehub/icons-static-svg@latest/icons/bailian-color.svg`，用
`rsvg-convert -w 512 -h 512` 栅格化为 512×512 PNG（2026-11-06）。

- 用途：百炼 Provider 在设置页的卡片图标。
- 处理：矢量按 512×512 栅格化，图形本身未改动。
- 归属：百炼 / Model Studio 名称与图形归阿里云所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的
`icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。

## 模型目录的来源

`src/catalog.ts` 不自己登记模型：它把 `@woohaa3/contracts` 里
`task/generation-parameters/cards/image/alibaba/` 的卡片读成执行路径的形状。比例、档位、官方
像素表、带参考图时的档位上限、负向提示词与智能改写都只写在卡片里，参数家族（`image-parameters`）
读的是同一份。

卡片目录按**研发厂商**归类：万相、Qwen-Image、Z-Image 都是阿里的模型，`alibaba` 指厂商；百炼
（Model Studio）是承载它们的通道，写在卡片的 `providerId` 上。同一个模型换走网关时，卡片与
目录都不用动。

卡片的**能力事实是手写的**：百炼有模型列表接口（`GET /api/v1/models`，需 Key，
`capabilities=IG` 可只看生图），但它只返回 id、名称、模态这类身份事实，给不出档位、官方像素表、
参考图上限、有没有负向提示词与智能改写——那些才决定参数面板长什么样。所以设置页的「刷新」走
`src/discovery.ts` 拉一次真实清单做**对账**（卡片登记的模型上游还在不在、有没有新模型没卡片），
注册表仍以卡片为准：没有卡片的模型不会被注册，否则用户选中后会撞上「模型未登记」。

事实来源：

- 生图总览 <https://help.aliyun.com/zh/model-studio/text-to-image>
- 模型列表（`GET /api/v1/models`）<https://help.aliyun.com/zh/model-studio/models>
- Qwen-Image 生图与编辑
  <https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference>
  （3.0 / 2.1 系列；2.0 系列仍看 <https://help.aliyun.com/zh/model-studio/qwen-image-api>）
- 通义万相 <https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference>
- Z-Image <https://help.aliyun.com/zh/model-studio/z-image-api-reference>

## 地址：优先业务空间专属域名

官方建议把请求迁到业务空间专属域名 `https://{业务空间ID}.{地域}.maas.aliyuncs.com`（北京与新加坡
已上线，老公开域名仍可用）。所以配置里有 `workspaceId` + `region`：填了就拼专属域名，
留空才用 `baseUrl`。没做「先试专属域名再退回老域名」——翻倍重试会把一次配置错误变成两次超时。

新增模型 = 在契约层的卡片目录里加一张卡片（`src/catalog.ts` 不用动）；同时更新本文件的来源与
`tests/schema.test.ts` 的档位完整性断言。

## 为什么面板没有「数量」

任务服务的结果归一化只取 `images[0]`（`services/task-service/src/worker/normalize.ts`），多出来的图
既进不了画布又会照常计费。所以即使上游支持 `n` 1–6，插件也只请求一张。
