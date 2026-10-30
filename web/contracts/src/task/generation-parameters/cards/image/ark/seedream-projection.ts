/**
 * 即梦（Seedream）版本的参数投影：**面板 schema + 请求字段**。
 *
 * 放在卡片目录里而不是 `image-parameters`：即梦有没有比例、有没有透明背景、档位怎么收窄，
 * 都是这个版本的事实，与「网关 / 原生」无关。Provider 只决定「什么时候用、翻成哪个字段」，
 * 不在这里再维护一份即梦知识。
 *
 * 投影分两块：
 * - `seedreamFamilySchema`：语义控件（比例 / 分辨率 / 背景）与默认值，带 `x-pptask-*` 标记；
 * - `seedreamRequestFields`：官方 `size`（+ 透明背景的 `background` / `output_format`）。
 *
 * 数据一律来自卡片投影出来的 `SeedreamSizePreset`，本文件不存版本数字。
 */
import {
  ADAPTIVE_PARAMETER_VALUE,
  aspectRatioField,
  backgroundField,
  isAdaptiveParameterValue,
  resolutionField,
} from "../../../../parameter-schema.js";
import {
  seedreamGatewayResolutions,
  seedreamPixelSize,
  seedreamSupportsAspectRatio,
  seedreamSupportsTransparentBackground,
  type SeedreamSizePreset,
} from "./seedream-spec.js";

/** 参数面板：比例（可选）+ 分辨率 + 背景（可选）。 */
export function seedreamFamilySchema(spec: SeedreamSizePreset): {
  properties: Record<string, unknown>;
  defaults: Record<string, unknown>;
} {
  // 即梦没有 `aspect_ratio`：能不能固定比例取决于该版本有没有官方像素表。
  const supportsRatio = seedreamSupportsAspectRatio(spec);
  // 透明背景只有 5.0 pro / flash 支持；`opaque` 是官方默认，所以不提供「自动」这一档
  // （即梦认的是 opaque，而不是 OpenAI 的 auto）。
  const supportsTransparent = seedreamSupportsTransparentBackground(spec);
  // 网关链路按收窄后的档位出面板（5.0 pro 经 LiteLLM 只有 1K / 2K）。
  const tiers = seedreamGatewayResolutions(spec);
  const defaultResolution = seedreamDefaultTier(spec, tiers);

  return {
    properties: {
      ...(supportsRatio
        ? {
            aspectRatio: aspectRatioField({
              ratios: spec.aspectRatios,
              fallback: ADAPTIVE_PARAMETER_VALUE,
              // 即梦「方式 1」= 只给档位、宽高比交给模型，就是面板的自适应。
              adaptive: true,
              title: "图片比例",
            }),
          }
        : {}),
      resolution: resolutionField({
        tiers,
        fallback: defaultResolution,
        title: "图片分辨率",
      }),
      ...(supportsTransparent ? { background: seedreamBackgroundField() } : {}),
    },
    defaults: {
      resolution: defaultResolution,
      ...(supportsRatio ? { aspectRatio: ADAPTIVE_PARAMETER_VALUE } : {}),
      ...(supportsTransparent ? { background: "opaque" } : {}),
    },
  };
}

/**
 * 背景控件：取值只有 `opaque`（官方默认）/ `transparent`，没有 OpenAI 的 `auto`。
 *
 * 官方：透明图输出默认 PNG，配 `output_format: jpeg` 直接报错，所以「透明」选项挂上格式
 * 联动（`x-pptask-requires`）——面板选中它就把输出格式切成 PNG 并锁住。5.0 pro / flash
 * 用同一套取值，因此不需要传 spec，调用方先判断该版本是否支持透明背景。
 */
export function seedreamBackgroundField(): Record<string, unknown> {
  return backgroundField({
    values: [
      { value: "opaque", label: "不透明" },
      { value: "transparent", label: "透明", requires: { outputFormat: "png" } },
    ],
    fallback: "opaque",
    title: "背景",
  });
}

/**
 * 请求字段：`size`（+ 5.0 pro / flash 的透明背景）。
 *
 * 官方两种写法都接受——比例 + 档位能查到官方像素值时给像素串（固定宽高比），
 * 查不到时退回档位串（`1K`/`2K`/`4K`，宽高比交给模型结合 prompt 决定）。
 * `quality` / `n` / `moderation` 不是即梦参数，一律不下发；`output_format` 也不单独下发
 * （它不影响出图，只作为透明模式的联动结果出现）。
 */
export function seedreamRequestFields(
  spec: SeedreamSizePreset | undefined,
  input: Record<string, unknown>,
): Record<string, string | number> {
  if (spec === undefined) return { size: "2K" };
  const tiers = seedreamGatewayResolutions(spec);
  const defaultTier = seedreamDefaultTier(spec, tiers);
  const requestedResolution = readText(input.resolution);
  // 旧草稿可能还留着网关不认的档位（如 5.0 pro 的 1.5K），这里按默认档收敛，
  // 不把注定被上游 400 的值发出去。
  const tier = requestedResolution && tiers.includes(requestedResolution) ? requestedResolution : defaultTier;
  const ratio = readText(input.aspectRatio ?? input.aspect_ratio);
  const normalizedRatio = ratio && !isAdaptiveParameterValue(ratio) ? ratio : undefined;
  const pixel = normalizedRatio ? seedreamPixelSize(spec, normalizedRatio, tier) : undefined;
  const explicit = readText(input.size);
  // 顺序即优先级：官方像素表查得到就固定宽高比；否则下发档位（没有比例表的版本如 4.0 也走这里）；
  // 旧草稿里直接写的像素 `size` 排在档位之后。
  const size = pixel
    ?? (requestedResolution && tiers.includes(requestedResolution) ? requestedResolution : undefined)
    ?? (explicit && /^\d{3,5}x\d{3,5}$/.test(explicit) ? explicit : defaultTier);
  const fields: Record<string, string | number> = { size };
  // 透明背景是 5.0 pro / flash 的能力：官方要求输出 PNG，配 `jpeg` 会被直接拒绝。
  // 面板已经联动切格式，这里对旧草稿 / 批处理 / 直接调 API 做最后一道——
  // 把格式补成 png，而不是悄悄退回不透明（用户要的是透明）。
  if (seedreamSupportsTransparentBackground(spec) && readText(input.background) === "transparent") {
    fields.background = "transparent";
    fields.output_format = "png";
  }
  return fields;
}

/** 默认档位始终落在可用档位里（收窄后的档位集合可能不含官方默认值）。 */
function seedreamDefaultTier(
  spec: { defaultResolution: string },
  tiers: readonly string[],
): string {
  if (tiers.includes(spec.defaultResolution)) return spec.defaultResolution;
  return tiers[tiers.length - 1] ?? spec.defaultResolution;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
