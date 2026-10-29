/**
 * 通用视频卡片：复刻服务端按类型写死的遗留形状。
 *
 * 保留它是为了「对照」：同一份目录里能同时看到「家族化后的面板」和「今天的样子」。
 * 没有家族、没有约束——服务端给什么就展示什么。
 */
import { videoCard } from "../../../card.js";

export const genericVideo = videoCard({
  id: "video-generic",
  title: "视频通用（托管服务端）",
  vendor: "generic",
  providerModelId: "video-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "服务端按类型写死的两个文本框，没有约束声明",
  keeps: [],
  adds: ["seconds", "size"]
});
