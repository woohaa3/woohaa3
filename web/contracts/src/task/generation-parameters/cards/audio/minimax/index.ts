import type { PresetCard } from "../../../card.js";
import { minimaxMusic } from "./music.js";
import { minimaxSpeech } from "./speech.js";

export const MINIMAX_AUDIO_CARDS: readonly PresetCard[] = [minimaxSpeech, minimaxMusic];
