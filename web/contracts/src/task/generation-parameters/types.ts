/**
 * 模型类型预设：**「这个类型该有哪些参数」的知识**，与厂商无关。
 *
 * video 该有时长 / 比例 / 分辨率，image 该有质量 / 数量——这是类型层面的常识。
 * 具体某个模型能不能用这些键、值域收到多少，由 `cards/` 下的卡片决定。
 *
 * 两者的分工要守住：这里写「默认值」，卡片写「这家实际能用到哪」。把厂商数字写进
 * 类型预设，就会出现「改一个 Provider 的档位要动全局」。
 */
import type { CanvasTaskModelType } from "../dto.js";

export type ModelTypePreset = {
  modelType: CanvasTaskModelType;
  /** 该类型默认具备的语义键，按展示顺序。 */
  keys: readonly string[];
  /** 合成 schema 时写进 `required` 的键。 */
  required: readonly string[];
  /** 每个键的预设值域；卡片可以在此基础上收窄。 */
  options: Readonly<Record<string, Record<string, unknown>>>;
};

/**
 * 有参数预设的模型类型。
 *
 * `language` 没有参数面板（提示词就是全部输入），所以不在卡片的覆盖范围内；
 * 其余类型新增时必须同时补一份预设，编译器会在这里报错。
 */
export type PresetModelType = Exclude<CanvasTaskModelType, "language">;

export const MODEL_TYPE_PRESETS: Readonly<Record<PresetModelType, ModelTypePreset>> = {
  image: {
    modelType: "image",
    keys: [
      "prompt",
      "referencesImage",
      "aspectRatio",
      "resolution",
      "quality",
      "n",
      "background",
      "outputFormat"
    ],
    required: ["prompt"],
    options: {
      referencesImage: { max: 10 },
      aspectRatio: {
        default: "1:1",
        adaptive: true,
        values: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"]
      },
      resolution: { title: "图片分辨率", default: "2K", values: ["1K", "1.5K", "2K", "4K"] },
      quality: { default: "auto", values: ["auto", "low", "medium", "high"] },
      n: { default: 1, maximum: 10 },
      background: { default: "auto", values: ["auto", "transparent", "opaque"] },
      outputFormat: { default: "png", values: ["png", "jpeg", "webp"] }
    }
  },
  video: {
    modelType: "video",
    keys: [
      "prompt",
      "referencesImage",
      "referencesVideo",
      "referencesAudio",
      "generationMode",
      "durationSeconds",
      "aspectRatio",
      "resolution",
      "generateAudio",
      "outputFormat",
      "seed",
      "cameraFixed",
      "returnLastFrame"
    ],
    required: ["prompt"],
    options: {
      referencesImage: { max: 30 },
      referencesVideo: { max: 10 },
      referencesAudio: { max: 10 },
      generationMode: {
        default: "omni_reference",
        enum: [
          { value: "omni_reference", label: "全能参考" },
          { value: "first_last_frame", label: "首尾帧" },
          { value: "edit_video", label: "视频编辑" }
        ]
      },
      durationSeconds: { default: 5, minimum: 4, maximum: 30 },
      aspectRatio: {
        default: "adaptive",
        adaptive: true,
        values: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]
      },
      resolution: { title: "分辨率", default: "720p", values: ["480p", "720p", "1080p"] },
      generateAudio: { default: true },
      outputFormat: { default: "mp4", values: ["mp4"] }
    }
  },
  audio: {
    modelType: "audio",
    // 音频没有画面类参数：提示词 + 音色 / 输出格式 / 语速就是全部语义。
    // 语音与音乐可以共用这套键；音乐模型的卡片按需剪掉 voice。
    keys: ["prompt", "voice", "outputFormat", "speed"],
    required: ["prompt"],
    options: {
      // 服务端 /v1/audio/speech 的缺省音色。具体模型能选哪些音色由卡片收窄；
      // 未收窄时保持自由文本——上游音色 id 不是一套跨厂商的枚举。
      voice: { default: "alloy" },
      outputFormat: { default: "mp3", values: ["mp3", "wav", "opus"] },
      speed: { default: 1, minimum: 0.25, maximum: 4, step: 0.05 }
    }
  }
};
