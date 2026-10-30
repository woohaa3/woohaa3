/**
 * Seedream 5.0 Pro（火山方舟 / 即梦）。
 *
 * 即梦没有 `aspect_ratio` 与 `quality`：宽高比只能写进 `size`。官方档位 1K / 1.5K / 2K，
 * 但**经 LiteLLM 网关调用时 pro 只放行 1K / 2K**，所以 `gatewayResolutions` 收窄网关链路；
 * 原生 Ark 直连仍按 `resolutions` 提供 1.5K。
 *
 * 透明背景（`background`）与 5.0 flash 同一批上线：取值 `opaque`（默认）/ `transparent`，
 * 官方限制是「图生图、只输入 1 张带透明通道的图片」，透明时输出必须 PNG。
 *
 * 这份卡片是 5.0 pro 能力的唯一来源：家族（`image-parameters`）与三家 Provider
 * （Ark 原生 / TokenHub / LiteLLM 网关）都按 `providerModelId` 读这里，不另存一份数字。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream50Pro = imageCard({
  id: "seedream-5.0-pro",
  title: "Seedream 5.0 Pro",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-pro-260628",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "即梦：没有 aspect_ratio / quality，宽高比只能写进 size；支持透明背景",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "background",
    "outputFormat"
  ],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5-pro", "doubao-seedream-5.0-pro", "doubao-seedream-5-0-pro"],
    prefixes: ["seedream-5-pro", "seedream-image-5-pro", "doubao-seedream-5-0-pro"],
    resolutions: ["1K", "1.5K", "2K"],
    gatewayResolutions: ["1K", "2K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("1K", "1.5K", "2K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921_600,
      maxTotalPixels: 4_624_220,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    transparentBackground: true
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
