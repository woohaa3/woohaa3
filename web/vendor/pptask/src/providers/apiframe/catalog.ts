import flux from './catalog/image__flux-2-pro.json';
import gptImage from './catalog/image__gpt-image-1.5.json';
import nanoBanana from './catalog/image__nano-banana-pro.json';
import seedream from './catalog/image__seedream-5-pro.json';
import mureka from './catalog/music__mureka.json';
import suno from './catalog/music__suno.json';
import kling from './catalog/video__kling-3.0.json';
import seedance from './catalog/video__seedance-2.json';
import sora from './catalog/video__sora-2-pro.json';
import veo from './catalog/video__veo-3.1.json';
import type { ProviderSchemaEntry } from '../shared/schema.ts';

export const APIFRAME_MODEL_CATALOG = [
  flux,
  gptImage,
  nanoBanana,
  seedream,
  mureka,
  suno,
  kling,
  seedance,
  sora,
  veo,
] as ProviderSchemaEntry[];

export const APIFRAME_SUPPORTED_MODELS = APIFRAME_MODEL_CATALOG.map(entry => entry.modelId);

export function getApiframeModelEntry(modelId: string): ProviderSchemaEntry | undefined {
  return APIFRAME_MODEL_CATALOG.find(entry => entry.modelId === modelId);
}
