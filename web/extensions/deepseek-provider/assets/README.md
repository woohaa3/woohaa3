# deepseek-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：DeepSeek 官方标志的矢量重绘（LobeHub 图标集 `@lobehub/icons-static-svg` 的
`deepseek-color.svg`，2026-11-10 取得），用 `rsvg-convert -w 512 -h 512` 栅格化为 512×512 PNG。
同目录保留的 `deepseek-color.svg` 就是这枚矢量原件，便于日后按需要重新栅格化。

- 用途：DeepSeek Provider 在设置页的卡片图标。
- 处理：矢量按 512×512 栅格化，图形本身未改动。
- 归属：DeepSeek 名称与图形归杭州深度求索（DeepSeek）所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的
`icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。

## 模型目录的来源

目录不在这里登记：`src/discovery.ts` 用官方 `GET /models` 的响应构造目录，代码里没有模型 id
清单。官方该接口是**自描述**的，模型条目带 `name`、`context_window`、`max_output_tokens`、
`input_modalities`、`output_modalities`、`effort.supported_levels` 与
`api_capabilities`，所以：

- 模态只看 `output_modalities`（含 `text` 才注册；缺省按文本处理）；
- 参考图能力只看 `input_modalities` 是否含 `image`；
- 思考档位与默认档位只看 `effort`；
- 输出上限只看 `max_output_tokens`（面板 `maxTokens` 的 `maximum`、请求 `max_tokens` 的上界）。

官方下架或改名后，下一次成功发现即生效；发现失败保留上一次成功目录（进程内存，不落盘），
诊断只记稳定事件名与脱敏原因，不回退到任何写死的模型清单。

事实来源：

- 模型与价格 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- 获取模型列表 <https://api-docs.deepseek.com/zh-cn/api/list-models>
- Chat Completions <https://api-docs.deepseek.com/zh-cn/api/create-chat-completion>
- 思考模式（`thinking` / `reasoning_effort`）<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- 图像理解（格式、单图上限、`image_url` 结构）<https://api-docs.deepseek.com/zh-cn/guides/vision>

## 只有文本

本期只实现 `/chat/completions`：`modelTypes: ["language"]`。官方同一 host 另有 Anthropic 兼容面
（`/anthropic`）与 Responses API，但宿主已有一条 `chat-completions` 协议入口，够用；为同一个
Provider 再挂第二套协议会增加「同一个 Key 走哪条路」的分叉，等有明确需求再加。

思考模式下官方明确 `temperature` / `presence_penalty` / `frequency_penalty` 不生效（传了不报错
但也不起作用），所以 Provider 在该模式下**不发送**这三个字段，避免面板上的值与真实行为不一致。
`top_p` 两档语义不同（Flash 只在思考模式生效且下限 0.95，Pro 在思考模式忽略），本期不把它投影成
面板控件，只在不开启思考时按调用方传入值转发。
