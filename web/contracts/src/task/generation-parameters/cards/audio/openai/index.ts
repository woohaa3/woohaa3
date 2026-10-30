import type { PresetCard } from "../../../card.js";
import { openaiTts } from "./tts.js";

export const OPENAI_AUDIO_CARDS: readonly PresetCard[] = [openaiTts];
