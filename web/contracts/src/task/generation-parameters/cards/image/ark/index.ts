import type { PresetCard } from "../../../card.js";
import { seedream50Pro } from "./seedream-5.0-pro.js";
import { seedream50Flash } from "./seedream-5.0-flash.js";
import { seedream50Lite } from "./seedream-5.0-lite.js";
import { seedream45 } from "./seedream-4.5.js";
import { seedream40 } from "./seedream-4.0.js";

/** 即梦全部在售 / 仍列出的版本：每张卡片就是该版本能力的唯一来源。 */
export const ARK_IMAGE_CARDS: readonly PresetCard[] = [
  seedream50Pro,
  seedream50Flash,
  seedream50Lite,
  seedream45,
  seedream40
];

/**
 * 即梦版本语义的出口：卡片查找（`seedream-cards`）与官方 `size` 查表（`seedream-spec`）。
 *
 * 家族（`image-parameters`）与三家 Provider 都从这里按 id 读卡片，不自己维护版本表。
 */
export {
  SEEDREAM_CARDS,
  SEEDREAM_SIZE_PRESETS,
  seedreamSizePresetFor,
  seedreamSpecOfCard
} from "./seedream-cards.js";
export {
  seedreamBackgroundField,
  seedreamFamilySchema,
  seedreamRequestFields
} from "./seedream-projection.js";
export {
  SEEDREAM_ASPECT_RATIOS,
  SEEDREAM_UNKNOWN_VERSION,
  seedreamGatewayResolutions,
  seedreamPixelSize,
  seedreamSizeTable,
  seedreamSupportsAspectRatio,
  seedreamSupportsTransparentBackground,
  type SeedreamResolutionTier,
  type SeedreamSizePreset
} from "./seedream-spec.js";
