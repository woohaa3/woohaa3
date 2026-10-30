# Ark Provider

后端扩展把火山方舟收成一个 Provider：文本走 Chat Completions，图片走 Seedream，视频走 Seedance。模型目录是内置的公开 Model ID；某个模型要能执行，还得在配置里写上它的推理接入点（`ep-`）。请求里的 `model` 用接入点 ID。

它是本机宿主插件树扩展层的插件。全部配置都在 `providers.ark` 里，设置页「模型 Provider」中的 Ark 卡片按这份声明生成表单。密钥类字段（`secret`）写进本地密钥文件 `web/woohaa.secrets.yml`（0600），其余写进 `web/woohaa.config.yml`；密钥不进入前端，设置页只显示「已配置 / 未配置」。

## 生成

| 配置项 | 说明 | 过渡期环境变量 |
| --- | --- | --- |
| `apiKey`（密钥） | 火山方舟 API Key | `ARK_VIDEO_API_KEY` |
| `baseUrl` | API 根路径，默认 `https://ark.cn-beijing.volces.com/api/v3`。如果值以 `/contents/generations/tasks` 结尾，会自动去掉，用来接住以前的视频任务地址 | `ARK_VIDEO_GENERATION_URL` |

设置页「模型接入点」按目录列出文本、图像和视频模型。勾选要用的模型，再填写它的推理接入点（`ep-` 开头）。没勾选或留空的模型不注册。`ARK_VIDEO_SEEDANCE2_0_MODEL` / `ARK_VIDEO_SEEDANCE2_5_MODEL` 会锁定对应模型的接入点。

## 即梦（Seedream）的图片参数

即梦接口没有 `aspect_ratio` / `quality` / `n`：宽高比只能写进 `size`，分辨率只能选官方档位。面板因此给「图片比例 + 图片分辨率」两个控件，档位、**比例 × 档位的官方像素表**、参考图上限与透明背景都来自**卡片**（[cards/image/ark/seedream-*.ts](../../../web/contracts/src/task/generation-parameters/cards/image/ark)，与其他 Provider 共用同一份数据）：

- 比例选具体画幅（1:1、16:9…）时，按该版本的官方像素表下发 `WIDTHxHEIGHT`，这才是真正固定宽高比；
- 比例选「自适应」（默认）时只下发分辨率档位，由模型结合提示词决定宽高——即官方推荐的「方式 1」；
- 图层拆分（仅 5.0 pro / flash）只接受档位，此时比例控件隐藏；
- 4.0 的官方文档只列出一组像素值、没有按档位拆分，所以不提供比例控件，只用档位。

组图（`sequential_image_generation`）只在 lite / 4.x 上出现，5.0 pro / flash 只出单图。

## 图片素材库

只作用于视频参考图。`assetGroupId`、`assetAccessKeyId`、`assetSecretAccessKey` 三项都非空时启用；全部为空时仍使用 Media 签发的 HTTPS 参考图。只配了一部分时插件装载失败，错误里列出缺少的项。生图继续使用 HTTPS 或 data URL，不会改写成 `asset://`。

| 配置项 | 默认值 | 过渡期环境变量 |
| --- | --- | --- |
| `assetGroupId` | 无 | `ARK_ASSET_GROUP_ID` |
| `assetAccessKeyId`（密钥） | 无 | `ARK_ASSET_ACCESS_KEY_ID` |
| `assetSecretAccessKey`（密钥） | 无 | `ARK_ASSET_SECRET_ACCESS_KEY` |
| `assetProjectName` | `default` | `ARK_ASSET_PROJECT_NAME` |
| `assetRegion` | `cn-beijing` | `ARK_ASSET_REGION` |
| `assetService` | `ark` | `ARK_ASSET_SERVICE` |
| `assetEndpoint` | `https://ark.cn-beijing.volcengineapi.com` | `ARK_ASSET_ENDPOINT` |
| `assetPollTimeoutMs` | `120000` | `ARK_ASSET_POLL_TIMEOUT_MS` |
| `assetPollIntervalMs` | `1000` | `ARK_ASSET_POLL_INTERVAL_MS` |

启用后，视频 `doStart` 使用签名 HTTPS 图片 URL 调用 OpenAPI `CreateAsset`（由上游下载图片），轮询 `GetAsset` 至 `Active`，再以 `asset://<id>` 提交生成请求。已有 `asset://` 引用直接复用；图片角色和顺序保持不变，视频/音频继续使用 HTTPS。同一请求中的重复图片只创建一次；目前没有跨任务或跨重启的素材缓存。

素材失败、超时或任务取消会终止流程，不回退到 HTTPS 后继续生成。

环境变量只为过渡兼容：设置了就优先生效，设置页上对应项显示为锁定。配置修改后即时生效，宿主会以新配置重启本插件。
