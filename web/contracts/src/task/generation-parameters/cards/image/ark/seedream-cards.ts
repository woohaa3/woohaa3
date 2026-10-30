/**
 * Seedream 卡片 → 官方 `size` 语义的投影。
 *
 * **卡片是唯一事实来源**：档位、官方像素表引用、默认档、网关收窄、透明背景、参考图上限
 * 全都写在同一目录的 `seedream-*.ts` 卡片里。本模块只做两件事：
 *
 * 1. 按模型 id 找卡片：精确 `providerModelId` → 卡片声明的别名 → 最长前缀（网关 id 带日期
 *    后缀、或换一个别名，都还能落回同一张卡片）；
 * 2. 把卡片投影成各 Provider 共用的 `SeedreamSizePreset`（`id` 与参考图上限取自卡片本身，
 *    不再另存一份数字）。
 *
 * 所以「新增一个即梦版本」= 加一张卡片，不需要往任何表里补一行数据。
 */

import type { PresetCard } from "../../../card.js";
import { seedream40 } from "./seedream-4.0.js";
import { seedream45 } from "./seedream-4.5.js";
import { seedream50Flash } from "./seedream-5.0-flash.js";
import { seedream50Lite } from "./seedream-5.0-lite.js";
import { seedream50Pro } from "./seedream-5.0-pro.js";
import {
  SEEDREAM_UNKNOWN_PREFIXES,
  SEEDREAM_UNKNOWN_VERSION,
  type SeedreamSizePreset
} from "./seedream-spec.js";

/** 卡片声明的即梦版本语义 → Provider 共用形状。 */
export function seedreamSpecOfCard(card: PresetCard): SeedreamSizePreset | undefined {
  const data = card.seedream;
  if (data === undefined) return undefined;
  const providerModelId = card.providerModelId.trim().toLowerCase();
  return {
    ...data,
    id: card.id,
    // 卡片自己的 providerModelId 也是别名：网关上就是拿它发现模型的。
    aliases: providerModelId === ""
      ? data.aliases
      : [providerModelId, ...(data.aliases ?? [])],
    // 参考图上限只存一份：卡片的 `limits`。
    maxReferenceImages: card.limits?.references?.image?.max ?? 14
  };
}

/** 声明了即梦版本语义的卡片（顺序即前缀兜底的顺序：更具体的版本排前面）。 */
export const SEEDREAM_CARDS: readonly PresetCard[] = [
  seedream50Pro,
  seedream50Flash,
  seedream50Lite,
  seedream45,
  seedream40
];

const SEEDREAM_SPECS: readonly { card: PresetCard; spec: SeedreamSizePreset }[] = SEEDREAM_CARDS.flatMap(
  (card) => {
    const spec = seedreamSpecOfCard(card);
    return spec === undefined ? [] : [{ card, spec }];
  }
);

/** 所有已登记的即梦版本（卡片投影，未登记版本不在这里）。 */
export const SEEDREAM_SIZE_PRESETS: readonly SeedreamSizePreset[] = SEEDREAM_SPECS.map(
  (entry) => entry.spec
);

function matchesPrefix(value: string, prefix: string): boolean {
  return value.startsWith(prefix.toLowerCase());
}

/**
 * 按模型 id 匹配即梦版本；未命中返回 undefined（调用方回退到自己的通用取值域）。
 *
 * 顺序即优先级：精确 id → 别名 → 最长前缀 → 兜底。最长前缀而不是登记顺序，是因为
 * `seedream-4` 与 `seedream-4-5` 这类前缀会互相包含，按长度才稳定。
 */
export function seedreamSizePresetFor(modelId: string): SeedreamSizePreset | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;

  const exact = SEEDREAM_SPECS.find(
    (entry) => entry.card.providerModelId.trim().toLowerCase() === normalized
  );
  if (exact !== undefined) return exact.spec;

  const alias = SEEDREAM_SPECS.find((entry) =>
    entry.spec.aliases?.some((value) => value.toLowerCase() === normalized) ?? false
  );
  if (alias !== undefined) return alias.spec;

  let best: { spec: SeedreamSizePreset; length: number } | undefined;
  for (const { spec } of SEEDREAM_SPECS) {
    for (const prefix of spec.prefixes ?? []) {
      if (!matchesPrefix(normalized, prefix)) continue;
      if (best === undefined || prefix.length > best.length) best = { spec, length: prefix.length };
    }
  }
  if (best !== undefined) return best.spec;

  // 认得出是即梦但版本未知：给保守档位，不猜像素表（真实版本一律走卡片）。
  if (SEEDREAM_UNKNOWN_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))) {
    return SEEDREAM_UNKNOWN_VERSION;
  }
  return undefined;
}
