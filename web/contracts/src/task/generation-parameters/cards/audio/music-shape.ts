/**
 * 音乐生成的共同形状。
 *
 * 语音合成（TTS）与音乐生成在网关上是**两条独立路由**：`/v1/audio/speech` 认
 * `voice` / `response_format` / `speed`，`/v1/audio/music` 只认 `prompt` 与 `lyrics`。
 * 两者的 `modelType` 都是 audio，差别只能由卡片表达。
 *
 * 卡片剪掉 voice / outputFormat / speed 有两个作用：
 * 1. 面板不再显示对音乐无效的音色与语速；
 * 2. 从语音模型切过来时，上一个模型留下的 `voice` 因为不在新 schema 里而被丢弃——
 *    这正是 `lyria3` 那次失败的直接原因（MiniMax 的 `male-qn-qingse` 被带进 lyria3，
 *    而 lyria3 只接受 OpenAI 音色名）。
 */
export const MUSIC_KEEPS = ["prompt", "lyrics"] as const;

/** 音乐卡片共用的说明：它们都不接受音色与语速。 */
export const MUSIC_NOTE = "音乐生成：只需提示词与可选歌词，没有音色与语速";
