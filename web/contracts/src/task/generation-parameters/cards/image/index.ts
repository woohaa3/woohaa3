import type { PresetCard } from "../../card.js";
import { ARK_IMAGE_CARDS } from "./ark/index.js";
import { ALIBABA_CARDS } from "./alibaba/alibaba-cards.js";
import { OPENAI_IMAGE_CARDS } from "./openai/index.js";
import { GOOGLE_IMAGE_CARDS } from "./google/index.js";
import { GENERIC_IMAGE_CARDS } from "./generic/index.js";

export const IMAGE_CARDS: readonly PresetCard[] = [
  ...ARK_IMAGE_CARDS,
  ...ALIBABA_CARDS,
  ...OPENAI_IMAGE_CARDS,
  ...GOOGLE_IMAGE_CARDS,
  ...GENERIC_IMAGE_CARDS
];
