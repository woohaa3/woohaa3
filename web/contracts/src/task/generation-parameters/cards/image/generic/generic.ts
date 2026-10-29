/**
 * 通用图片卡片：复刻服务端按类型写死的一个像素 `size`。
 *
 * 保留它是为了对照：没有家族、没有约束，面板就是一个文本框。
 */
import { imageCard } from "../../../card.js";

export const genericImage = imageCard({
  id: "image-generic",
  title: "图片通用（托管服务端）",
  vendor: "generic",
  providerModelId: "image-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "服务端按类型写死一个像素 size，没有约束声明",
  keeps: [],
  adds: ["size"]
});
