import seedance2 from './catalog/market__bytedance__seedance-2.json';
import seedance2Fast from './catalog/market__bytedance__seedance-2-fast.json';
import dialogue from './catalog/market__elevenlabs__text-to-dialogue-v3.json';
import speech from './catalog/market__elevenlabs__text-to-speech-multilingual-v2.json';
import fluxI2i from './catalog/market__flux-2__pro-image-to-image.json';
import fluxT2i from './catalog/market__flux-2__pro-text-to-image.json';
import grokI2i from './catalog/market__grok-imagine__image-to-image.json';
import grokT2i from './catalog/market__grok-imagine__text-to-image.json';
import klingMotion from './catalog/market__kling-3.0__motion-control.json';
import klingVideo from './catalog/market__kling-3.0__video.json';
import seedreamI2i from './catalog/market__seedream__5-pro-image-to-image.json';
import seedreamT2i from './catalog/market__seedream__5-pro-text-to-image.json';
import type { ProviderSchemaEntry } from '../shared/schema.ts';

export const KIE_MODEL_CATALOG = [
  seedance2,
  seedance2Fast,
  dialogue,
  speech,
  fluxI2i,
  fluxT2i,
  grokI2i,
  grokT2i,
  klingMotion,
  klingVideo,
  seedreamI2i,
  seedreamT2i,
] as ProviderSchemaEntry[];

export const KIE_SUPPORTED_MODELS = KIE_MODEL_CATALOG.map(entry => entry.modelId);

export function getKieModelEntry(modelId: string): ProviderSchemaEntry | undefined {
  return KIE_MODEL_CATALOG.find(entry => entry.modelId === modelId);
}
