import type { PresetCard } from "../../../card.js";
import { gptImage25 } from "./gpt-image-2.5.js";
import { gptImage25Flare } from "./gpt-image-2.5-flare.js";
import { gptImage25Sunburst } from "./gpt-image-2.5-sunburst.js";

export const OPENAI_IMAGE_CARDS: readonly PresetCard[] = [
  gptImage25Sunburst,
  gptImage25Flare,
  gptImage25
];
