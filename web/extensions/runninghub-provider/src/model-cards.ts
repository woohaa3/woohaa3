/**
 * RunningHub 的面板投影：把内置模型卡片接到**上游参数表**上
 * （与 `remote-server` 的 `withModelFamily` / `translateParameters` 是同一套接法）。
 *
 * 为什么需要这一层：
 * - 入库清单 `data/models.json` 是**上游 API 的字段表**，直接摊到面板上就是
 *   `width` / `height` / `resolution: 2k|3k` / `duration: "5"` 这类机器字段；
 * - 同一个模型在 Ark / 网关链路上用的是卡片语义（比例 / 档位 / 时长 / 质量），
 *   换一个 Provider 不该换一套参数名；
 * - 两边的模型 id 不是一套（`seedream-v5-lite` vs `doubao-seedream-5-0-260128`，
 *   `rhart-video/sparkvideo-2.0` vs `seedance-2`），所以只能显式映射，不能靠前缀猜。
 *
 * 四条边界：
 * 1. **上游是落点**：只保留上游 `inputSchema` 里真的有的键。卡片多出来的（`n`、经济版的
 *    `quality`、即梦的 `outputFormat`）不摆到面板上——摆了也发不出去；
 * 2. **卡片是展示真相**：值域取交集，顺序 / label / 默认值 / 控件语义（`x-pptask-control`）
 *    来自卡片；上游多出来的值接在后面，不砍上游真实支持的能力；
 * 3. **字段名归卡片**：上游的 `ratio` / `duration` 在面板上叫 `aspectRatio` /
 *    `durationSeconds`（见 `FIELD_ALIASES`），提交时再换回去；
 * 4. **翻译只在提交时发生**：比例 + 档位 → `width`/`height`（即梦官方像素表）、
 *    时长数字 → 上游的字符串档位，都在 `translateRunningHubParameters` 里做。
 *
 * 参考素材与 `prompt` 一律沿用上游声明：前者决定绑定字段名与上传通道，后者带上游的长度上限。
 */
import {
  BUILTIN_PRESET_CARDS,
  composePresetCard,
  isAdaptiveParameterValue,
  seedreamPixelSize,
  seedreamSpecOfCard,
  type PresetCard,
  type SeedreamSizePreset
} from "@woohaa3/contracts";

/** 投影只需要「身份 + 上游参数表」；不引入 `shared.ts` 的清单类型，避免循环依赖。 */
export type RunningHubCardTarget = {
  /** 逻辑模型 id（`data/models.json` 的 `id`）。 */
  id: string;
  /** 输出类型：卡片只能配给同类型的模型。 */
  outputType?: "image" | "video";
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
};

export type RunningHubCardSchema = {
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
};

/**
 * 逻辑模型 id → 内置卡片 id。
 *
 * 两套命名对不上是常态：RunningHub 用渠道 id（`rhart-image-g-2.5/...`）、去掉 `doubao-`
 * 前缀的短 id（`seedream-v5-lite`）或自家代号（`sparkvideo-2.0`）。
 *
 * 分族依据来自本扩展自己的派生脚本（`scripts/generate-models.mjs` 的 `familyOf`）：
 * `rhart-image-g-*` = GPT Image、`rhart-image-n-*` = Nano Banana、`seedream-v*` /
 * `dola-Seedream-*` / `bytedance/jimeng-*` = Seedream、`bytedance/seedance-*` /
 * `seedance-v1*` / `rhart-video/sparkvideo-*` = Seedance。
 *
 * 只有在**同族同代**时才登记。同族不同代（GPT Image 2 / 2.5、Seedance v1 / v2）也登记，
 * 因为面板值域是「卡片 ∩ 上游」——卡片只贡献顺序、label 与默认值，多出来的档位会被上游
 * 挡掉，不会凭空许诺能力。刻意不登记的是**身份还不确定**的：`rhart-image-g-1.5`
 * （上游给的是固定像素 `size`，跟我们任何一张卡片都不是一套参数）、`rhart-image-g-3/g-4`
 * （上游只有提示词与参考图，没有可投影的参数）、`bytedance/jimeng-4.6`（`scale` /
 * `minRatio` / `maxRatio` 是它自己的缩放窗口，换不成我们的档位）。
 */
const CARD_IDS: Readonly<Record<string, string>> = {
  // Seedream（即梦）
  "seedream-v4": "seedream-4.0",
  "seedream-v4.5": "seedream-4.5",
  "seedream-v5-lite": "seedream-5.0-lite",
  "seedream-v5-pro": "seedream-5.0-pro",
  "dola-Seedream-5.0-pro": "seedream-5.0-pro",
  // GPT Image（2.5 有独立卡；2 同族同参，用 2.5 当模板，值域仍取交集）
  "rhart-image-g-2": "gpt-image-2.5",
  "rhart-image-g-2-official": "gpt-image-2.5",
  "rhart-image-g-2.5-official-token/flare": "gpt-image-2.5-flare",
  "rhart-image-g-2.5-official-token/sunburst": "gpt-image-2.5-sunburst",
  "rhart-image-g-2.5/flare": "gpt-image-2.5-flare",
  "rhart-image-g-2.5/sunburst": "gpt-image-2.5-sunburst",
  // Nano Banana（n-g31 = Gemini 3.1 Flash 底；n-pro = Nano Banana Pro 参数族）
  "rhart-image-n-g31-flash": "gemini-3.1-flash-image",
  "rhart-image-n-g31-flash-official": "gemini-3.1-flash-image",
  "rhart-image-n-g31-flash-lite": "gemini-3.1-flash-image",
  "rhart-image-n-g31-flash-lite-official": "gemini-3.1-flash-image",
  "rhart-image-n-pro": "nano-banana-2",
  "rhart-image-n-pro-official": "nano-banana-2",
  // Seedance
  "bytedance/seedance-2.0-global": "seedance-2.0",
  "bytedance/seedance-2.0-global-fast": "seedance-2.0",
  "rhart-video/sparkvideo-2.0": "seedance-2.0",
  "rhart-video/sparkvideo-2.0-fast": "seedance-2.0",
  "rhart-video/sparkvideo-2.0-mini": "seedance-2.0",
  "seedance-v1-lite": "seedance-1.0"
};

/**
 * 上游字段名 → 卡片字段名。
 *
 * 卡片是跨 Provider 的语义层（`aspectRatio` / `durationSeconds`），RunningHub 视频接口
 * 叫 `ratio` / `duration`。面板只出现卡片名，提交时换回上游名（`REVERSE_ALIASES`）。
 */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  ratio: "aspectRatio",
  duration: "durationSeconds"
};

const REVERSE_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FIELD_ALIASES).map(([upstream, panel]) => [panel, upstream])
);

/**
 * 刷新新增模型的兜底映射：按 id 规则挑一张**展示模板**。
 *
 * 精确表（`CARD_IDS`）只认签过字的 id；运行期从 registry 发现的新版本不可能预先登记，
 * 但它们的参数族是稳定的，所以按族给一张卡。值域仍是「卡片 ∩ 上游」，多出来的档位不会
 * 被许诺出去；这里只决定顺序、label 与默认值。
 */
const CARD_RULES: ReadonlyArray<{ test: RegExp; cardId: string; outputType: "image" | "video" }> = [
  // 即梦 5.0 flash（含 Dola 渠道）：档位 1K / 1.5K / 2K + 比例表，跟 5.0 flash 卡完全一致。
  { test: /(^|\/)seedream-v5-flash$|^dola-Seedream-5\.0-flash$/, cardId: "seedream-5.0-flash", outputType: "image" },
  // 4.7 只有档位没有接入比例表，用 4.0 卡（宽高留给人填）比借 4.5 的像素表安全。
  { test: /^seedream-v4\.7$/, cardId: "seedream-4.0", outputType: "image" },
  // nano-banana 2.1 的比例集与 Gemini 3.1 Flash 一致（含 1:4 / 1:8）。
  { test: /^rhart-image-n-nb\d/, cardId: "gemini-3.1-flash-image", outputType: "image" },
  // 视频：2.5 与 1.5 分别借同族卡片；时长会按上游枚举夹取，不会发出越界值。
  { test: /(^|\/)seedance-2\.5/, cardId: "seedance-2.5", outputType: "video" },
  { test: /^seedance-v1\.5/, cardId: "seedance-2.0", outputType: "video" }
];

/** 面板自己承载、不参与卡片合成的键：参考素材与提示词以上游声明为准。 */
const UPSTREAM_OWNED_KEYS = new Set(["prompt", "imageUrls", "urls"]);

/**
 * 上游独有键的中文 label。
 *
 * 上游参数表只有 key 没有 `title`，面板会直接显示 `maxImages` 这种字段名；这里只补
 * **卡片没有覆盖**的那几个，不改值域、不改默认值。
 */
const KEY_TITLES: Readonly<Record<string, string>> = {
  sequentialImageGeneration: "组图",
  maxImages: "组图张数",
  toolsType: "联网工具"
};

/** 「自适应」的两种写法：卡片用 `auto`，RunningHub 视频用 `adaptive`。 */
const ADAPTIVE_VALUES = new Set(["auto", "adaptive"]);

/** 逻辑模型对应的卡片；未登记映射或类型不符时返回 undefined。 */
export function runningHubCard(logicalId: string, outputType?: "image" | "video"): PresetCard | undefined {
  // 精确表优先，其次按族规则（刷新新发现的版本走这里）。
  const cardId = CARD_IDS[logicalId] ?? cardIdFromRules(logicalId, outputType)?.cardId;
  if (cardId === undefined) return undefined;
  return BUILTIN_PRESET_CARDS.find(
    (card) =>
      card.id === cardId &&
      // 只接图片 / 视频：音频既有下发形状与卡片一致，没有这里要翻译的东西。
      (card.modelType === "image" || card.modelType === "video") &&
      (outputType === undefined || card.modelType === outputType)
  );
}

function cardIdFromRules(
  logicalId: string,
  outputType: "image" | "video" | undefined
): { cardId: string } | undefined {
  const rule = CARD_RULES.find(
    (candidate) =>
      candidate.test.test(logicalId) && (outputType === undefined || candidate.outputType === outputType)
  );
  return rule === undefined ? undefined : { cardId: rule.cardId };
}

/**
 * 卡片语义 × 上游字段 → 面板 schema。
 *
 * 命中映射的模型：键集合以上游为准（顺序尽量按卡片），值域取交集，默认值优先卡片；
 * 未命中映射的模型：原样返回，保持「上游自描述」这条兜底。
 */
export function runningHubCardSchema(target: RunningHubCardTarget): RunningHubCardSchema {
  const card = runningHubCard(target.id, target.outputType);
  if (card === undefined) {
    return { inputSchema: target.inputSchema, defaultInput: target.defaultInput };
  }
  const composed = composePresetCard(card).model;
  const upstream = propertiesOf(target.inputSchema);
  const panel = propertiesOf(composed.inputSchema);
  // 即梦的「比例 → 像素」只有拿到卡片里的官方像素表才算得出来；没有表（4.0）时
  // 保留上游的 width/height，让用户自己填，而不是悄悄发一个我们猜的尺寸。
  const pixelMapped = pixelsMapped(seedreamSpecOfCard(card), upstream);

  const projected: Record<string, Record<string, unknown>> = {};
  for (const [upstreamKey, upstreamProperty] of Object.entries(upstream)) {
    const fromUpstream = keyOfUpstream(upstreamKey);
    const panelProperty = panel[fromUpstream];
    if (pixelMapped && (upstreamKey === "width" || upstreamKey === "height")) continue;
    if (UPSTREAM_OWNED_KEYS.has(upstreamKey) || panelProperty === undefined) {
      projected[fromUpstream] = withTitle(upstreamProperty, KEY_TITLES[upstreamKey]);
      continue;
    }
    projected[fromUpstream] = projectProperty(fromUpstream, panelProperty, upstreamProperty);
  }

  // 卡片独有、但能落到上游别的字段上的键：即梦的比例最终进 width/height。
  const aspectRatio = panel.aspectRatio;
  if (pixelMapped && aspectRatio !== undefined && projected.aspectRatio === undefined) {
    projected.aspectRatio = aspectRatio;
  }

  const properties = orderByCard(projected, panel, upstream);
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (property.default !== undefined) defaults[key] = property.default;
  }

  const declaredRequired = Array.isArray(target.inputSchema.required)
    ? target.inputSchema.required.filter((key): key is string => typeof key === "string")
    : [];
  const required = declaredRequired
    .map((key) => keyOfUpstream(key))
    .filter((key) => properties[key] !== undefined);

  const { properties: _properties, required: _required, ...rest } = target.inputSchema;
  return {
    inputSchema: { ...rest, type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    defaultInput: defaults
  };
}

/**
 * 面板参数 → 上游请求字段。
 *
 * 值域本来就是交集（枚举值直接取上游写法），所以这里只做上游表达不了的事：
 * 1. 字段名换回上游（`aspectRatio` → `ratio`、`durationSeconds` → `duration`）；
 * 2. 时长数字收敛到上游的字符串档位（相邻取整，越界夹到首尾）；
 * 3. 即梦的比例 + 档位 → `width`/`height`（官方像素表；自适应按方形算）；
 * 4. 丢掉上游没有的键（旧草稿/批处理可能带着上一版面板的字段）。
 *
 * 未登记映射的模型原样返回——那是 Provider 直传上游形状的既有行为。
 */
export function translateRunningHubParameters(
  target: RunningHubCardTarget,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const card = runningHubCard(target.id, target.outputType);
  if (card === undefined) return parameters;
  const upstream = propertiesOf(target.inputSchema);
  // 比例在上游表里可能根本没有（即梦只有 width/height），所以要在过滤前先取出来。
  const aspectRatio = readText(parameters.aspectRatio);

  const fields: Record<string, unknown> = {};
  for (const [panelKey, value] of Object.entries(parameters)) {
    if (value === undefined || panelKey === "aspectRatio") continue;
    // 先认同名键（`seedance-v1-lite` 上游本来就叫 `aspectRatio`），再走别名。
    const upstreamKey = upstream[panelKey] !== undefined ? panelKey : REVERSE_ALIASES[panelKey];
    if (upstreamKey === undefined || upstream[upstreamKey] === undefined) continue;
    fields[upstreamKey] = value;
  }

  // 比例单独处理：面板叫 `aspectRatio`，上游可能也叫这个名字，也可能叫 `ratio`。
  const ratioKey = upstream.aspectRatio !== undefined ? "aspectRatio" : "ratio";
  const ratio = resolveAspectRatio(aspectRatio, upstream[ratioKey]);
  if (ratio !== undefined && upstream[ratioKey] !== undefined) fields[ratioKey] = ratio;

  translateDuration(fields, upstream.duration);
  normalizeResolution(fields, upstream.resolution);

  const spec = seedreamSpecOfCard(card);
  if (!pixelsMapped(spec, upstream)) return fields;

  const tier = tierOf(spec, fields.resolution);
  const pixel = seedreamPixelSize(
    spec,
    aspectRatio !== undefined && !isAdaptiveParameterValue(aspectRatio) ? aspectRatio : "1:1",
    tier
  );
  delete fields.aspectRatio;
  delete fields.ratio;
  if (pixel === undefined) return fields;
  const [width, height] = pixel.split("x").map((value) => Number(value));
  if (Number.isFinite(width) && Number.isFinite(height)) {
    fields.width = width;
    fields.height = height;
  }
  return fields;
}

/** 时长：面板上是数字，上游是字符串档位。夹到首尾并取最近的允许值。 */
function translateDuration(fields: Record<string, unknown>, schema: Record<string, unknown> | undefined): void {
  const value = fields.duration;
  if (schema === undefined || value === undefined) return;
  const allowed = optionsOf(schema)
    .map((option) => option.value)
    .filter((option) => /^\d+$/.test(option))
    .map((option) => Number(option));
  const requested = Number(value);
  if (allowed.length === 0 || !Number.isFinite(requested)) {
    delete fields.duration;
    return;
  }
  const min = Math.min(...allowed);
  const max = Math.max(...allowed);
  const clamped = Math.min(Math.max(Math.round(requested), min), max);
  const nearest = allowed.reduce((best, current) =>
    Math.abs(current - clamped) < Math.abs(best - clamped) ? current : best
  );
  fields.duration = String(nearest);
}

/**
 * 比例取值：卡片的「自适应」叫 `auto`，上游可能叫 `adaptive`；上游不认的值不下发。
 *
 * 返回 `undefined` 表示「这次不该带比例」（旧草稿里的脏值），由调用方按上游默认处理。
 */
function resolveAspectRatio(value: string | undefined, schema: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined;
  const options = optionsOf(schema);
  if (options.length === 0) return value;
  if (isAdaptiveParameterValue(value)) {
    return options.find((option) => ADAPTIVE_VALUES.has(option.value.toLowerCase()))?.value;
  }
  return options.some((option) => option.value === value) ? value : undefined;
}

/** 档位：上游枚举大小写与面板 label 不一致（`2k` vs `2K`）；对不上宁可不下发。 */
function normalizeResolution(fields: Record<string, unknown>, schema: Record<string, unknown> | undefined): void {
  if (fields.resolution === undefined) return;
  const options = optionsOf(schema);
  if (options.length === 0) return;
  const canonical = options.find(
    (option) => option.value.toLowerCase() === String(fields.resolution).trim().toLowerCase()
  );
  if (canonical === undefined) delete fields.resolution;
  else fields.resolution = canonical.value;
}

/** 这个模型是「比例 + 档位 → 像素」通道：上游收 width/height，且卡片有官方像素表。 */
function pixelsMapped(
  spec: SeedreamSizePreset | undefined,
  upstream: Record<string, Record<string, unknown>>
): spec is SeedreamSizePreset {
  return (
    spec !== undefined &&
    Object.keys(spec.sizes).length > 0 &&
    upstream.width !== undefined &&
    upstream.height !== undefined
  );
}

/** 上游的档位写法（`2k`）→ 卡片档位（`2K`）；无匹配时用该版本的默认档。 */
function tierOf(spec: SeedreamSizePreset, value: unknown): string {
  const requested = readText(value)?.toLowerCase();
  const match = requested === undefined
    ? undefined
    : spec.resolutions.find((tier) => tier.toLowerCase() === requested);
  return match ?? spec.defaultResolution;
}

/** 上游字段名 → 面板字段名（`ratio` → `aspectRatio`）。 */
function keyOfUpstream(upstreamKey: string): string {
  return FIELD_ALIASES[upstreamKey] ?? upstreamKey;
}

/**
 * 分辨率：面板用卡片档位当 label、值仍是上游写法（`2k`），因此提交时只需要大小写归一。
 * 交集为空（该渠道不支持这个版本）时整份退回上游声明。
 */
function projectResolution(panel: Record<string, unknown>, upstream: Record<string, unknown>): Record<string, unknown> {
  const upstreamValues = optionsOf(upstream).map((option) => option.value);
  if (upstreamValues.length === 0) return upstream;
  const options = optionsOf(panel).flatMap((option) => {
    const match = upstreamValues.find((value) => value.toLowerCase() === option.value.toLowerCase());
    return match === undefined ? [] : [{ value: match, label: option.label }];
  });
  if (options.length === 0) return upstream;
  return { ...panel, enum: options, default: preferredDefault(options, panel, upstream) };
}

/** 面板键 → 投影方式：比例要合「自适应」，时长要换成数字区间，其余是普通枚举。 */
function projectProperty(
  panelKey: string,
  panel: Record<string, unknown>,
  upstream: Record<string, unknown>
): Record<string, unknown> {
  if (panelKey === "aspectRatio") return projectAspectRatio(panel, upstream);
  if (panelKey === "durationSeconds") return projectDuration(panel, upstream);
  if (panelKey === "resolution") return projectResolution(panel, upstream);
  return projectEnum(panel, upstream);
}

/**
 * 比例：卡片的值在前（带卡片 label 与顺序），上游多出来的值接在后面。
 *
 * 「自适应」在两边叫法不同（卡片 `auto`、RunningHub 视频 `adaptive`）：合成**一个**
 * 选项，值取上游写法，这样提交时不需要再翻译。
 */
function projectAspectRatio(panel: Record<string, unknown>, upstream: Record<string, unknown>): Record<string, unknown> {
  const upstreamOptions = optionsOf(upstream);
  if (upstreamOptions.length === 0) return upstream;
  const upstreamAdaptive = upstreamOptions.find((option) => ADAPTIVE_VALUES.has(option.value.toLowerCase()));
  const panelAdaptive = optionsOf(panel).find((option) => ADAPTIVE_VALUES.has(option.value.toLowerCase()));
  const options: Array<{ value: string; label: string; [key: string]: unknown }> = [];
  if (upstreamAdaptive !== undefined) {
    options.push({
      value: upstreamAdaptive.value,
      label: panelAdaptive?.label ?? "自适应",
      "x-pptask-adaptive": true
    });
  }
  const matched = optionsOf(panel).filter(
    (option) =>
      upstreamOptions.some((candidate) => candidate.value === option.value) &&
      // 上游的 `auto` 已经被上面合成为「自适应」选项，不能再来一个。
      !options.some((candidate) => candidate.value === option.value)
  );
  if (matched.length === 0 && upstreamAdaptive === undefined) return upstream;
  options.push(...matched);
  for (const option of upstreamOptions) {
    if (option === upstreamAdaptive) continue;
    if (options.some((candidate) => candidate.value === option.value)) continue;
    options.push(option);
  }
  return { ...panel, enum: options, default: preferredDefault(options, panel, upstream) };
}

/**
 * 时长：卡片是数字（`durationSeconds`），上游是字符串档位枚举。这里把卡的控件换成
 * 上游档位的数字区间，提交时再由 `translateDuration` 收敛成具体档位——面板不暴露字符串。
 */
function projectDuration(panel: Record<string, unknown>, upstream: Record<string, unknown>): Record<string, unknown> {
  const allowed = optionsOf(upstream)
    .map((option) => option.value)
    .filter((option) => /^\d+$/.test(option))
    .map((option) => Number(option));
  if (allowed.length === 0) return panel;
  const minimum = Math.min(...allowed);
  const maximum = Math.max(...allowed);
  const requested = Number(panel.default);
  const fallback = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), minimum), maximum)
    : minimum;
  const property: Record<string, unknown> = { ...panel, minimum, maximum, default: fallback };
  delete property.enum;
  return property;
}

/** 其它枚举（质量 / 背景 / 输出格式）：卡片的值与 label 在前，上游多出来的值接在后面。 */
function projectEnum(panel: Record<string, unknown>, upstream: Record<string, unknown>): Record<string, unknown> {
  const upstreamOptions = optionsOf(upstream);
  if (upstreamOptions.length === 0) return upstream;
  const matched = optionsOf(panel).filter((option) =>
    upstreamOptions.some((candidate) => candidate.value === option.value)
  );
  if (matched.length === 0) return upstream;
  const options = [...matched];
  for (const option of upstreamOptions) {
    if (options.some((candidate) => candidate.value === option.value)) continue;
    options.push(option);
  }
  return { ...panel, enum: options, default: preferredDefault(options, panel, upstream) };
}

/** 默认值顺序：卡片的默认值 → 上游的默认值 → 第一个可选项。 */
function preferredDefault(
  options: ReadonlyArray<{ value: string }>,
  panel: Record<string, unknown>,
  upstream: Record<string, unknown>
): string {
  const candidates = [readText(panel.default), readText(upstream.default)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const match = options.find((option) => ADAPTIVE_VALUES.has(option.value.toLowerCase()) && ADAPTIVE_VALUES.has(candidate.toLowerCase()))
      ?? options.find((option) => option.value === candidate);
    if (match !== undefined) return match.value;
  }
  return options[0]!.value;
}

/** 展示顺序：卡片声明的键优先，其余按上游顺序追加。 */
function orderByCard(
  projected: Record<string, Record<string, unknown>>,
  panel: Record<string, Record<string, unknown>>,
  upstream: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const ordered: Record<string, Record<string, unknown>> = {};
  for (const key of [...Object.keys(panel), ...Object.keys(upstream).map(keyOfUpstream)]) {
    if (ordered[key] !== undefined) continue;
    const property = projected[key];
    if (property !== undefined) ordered[key] = property;
  }
  return ordered;
}

/** 上游没写 title 时补一个中文 label；已经有了就不覆盖。 */
function withTitle(
  property: Record<string, unknown>,
  title: string | undefined
): Record<string, unknown> {
  if (title === undefined || property.title !== undefined) return property;
  return { ...property, title };
}

function propertiesOf(schema: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
  const properties = asObject(schema?.properties);
  if (properties === undefined) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = asObject(value);
    if (property !== undefined) result[key] = property;
  }
  return result;
}

function optionsOf(schema: Record<string, unknown> | undefined): Array<{ value: string; label: string }> {
  const entries = Array.isArray(schema?.enum) ? schema.enum : [];
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      options.push({ value: entry, label: entry });
      continue;
    }
    const record = asObject(entry);
    const value = readText(record?.value);
    if (value === undefined) continue;
    options.push({ value, label: readText(record?.label) ?? value });
  }
  return options;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
