/**
 * 图层名的中文显示（A11）
 *
 * 内核（以及 PSD 往返）里的图层名是**持久数据**：`Layer 0`、`Curves 1`、`Layer 0 copy` 这些
 * 名字来自上游引擎的默认命名，也是 PSD 里能对上的同一个字段。为了「中文界面里不出现英文默认名」
 * 去改内核命名，会让同一份工程在外部软件里打开时图层名变样，也会破坏 PSD 往返的可比对性。
 *
 * 所以这里只做**显示层**的映射：渲染时把引擎默认名换成中文，重命名仍然写回原始字段。
 * 用户自己起的名字（不匹配任何默认形态）原样显示，绝不猜。
 *
 * 纯函数、无 DOM、无内核依赖，方便回归。
 */

/** 默认图层名：`Layer` / `Layer 3` / `Layer 3 copy` / `Layer 3 copy 2`。 */
const LAYER_PATTERN = /^Layer(?: (\d+))?(?: copy(?: (\d+))?)?$/;
/** 默认调整层名：`Curves` / `Curves 1`。 */
const ADJUSTMENT_PATTERN = /^(Brightness\/Contrast|Levels|Curves|Exposure|Vibrance|Hue\/Saturation|Color Balance|Black & White|Photo Filter|Channel Mixer|Color Lookup|Invert|Posterize|Threshold|Gradient Map|Selective Color)(?: (\d+))?$/;

/** 引擎默认调整层名的中文名。 */
const ADJUSTMENT_NAMES: Record<string, string> = {
  "Brightness/Contrast": "亮度/对比度",
  Levels: "色阶",
  Curves: "曲线",
  Exposure: "曝光度",
  Vibrance: "自然饱和度",
  "Hue/Saturation": "色相/饱和度",
  "Color Balance": "色彩平衡",
  "Black & White": "黑白",
  "Photo Filter": "照片滤镜",
  "Channel Mixer": "通道混合器",
  "Color Lookup": "颜色查找",
  Invert: "反相",
  Posterize: "色调分离",
  Threshold: "阈值",
  "Gradient Map": "渐变映射",
  "Selective Color": "可选颜色"
};

/** 笔刷预设分组名（内核默认分组）。 */
const BRUSH_GROUPS: Record<string, string> = {
  round: "圆形",
  sampled: "采样笔尖",
};

/** 程序性默认笔刷名。 */
const BRUSH_NAMES: Record<string, string> = {
  "Hard Round": "硬边圆",
  "Soft Round": "柔边圆",
  "Soft Round Pressure": "柔边圆（压感）",
  "Sampled Soft Dot": "采样柔点",
  "Sampled Notched": "采样缺口",
};

/**
 * 图层显示名。只有**完全匹配**引擎默认形态时才翻译，否则原样返回。
 *
 * `Layer 3 copy` → `图层 3 拷贝`；`Curves 1` → `曲线 1`；`我的海报` → `我的海报`。
 */
export function displayLayerName(name: string): string {
  if (typeof name !== "string" || name === "") return name;
  const layer = LAYER_PATTERN.exec(name);
  if (layer) {
    // `Layer` → `图层`；`Layer 3` → `图层 3`；`Layer 3 copy` → `图层 3 拷贝`；
    // `Layer 3 copy 2` → `图层 3 拷贝 2`（第二份拷贝的序号照抄）。
    const index = layer[1] ? ` ${layer[1]}` : "";
    const copied = name.includes(" copy") ? " 拷贝" : "";
    const ordinal = layer[2] ? ` ${layer[2]}` : "";
    return `图层${index}${copied}${ordinal}`;
  }
  const adjustment = ADJUSTMENT_PATTERN.exec(name);
  if (adjustment) {
    const label = ADJUSTMENT_NAMES[adjustment[1]!] ?? adjustment[1]!;
    return adjustment[2] ? `${label} ${adjustment[2]}` : label;
  }
  return name;
}

/** 笔刷预设显示名：只翻译程序性默认名；导入的笔刷保留用户给的名字。 */
export function displayBrushPresetName(name: string): string {
  return BRUSH_NAMES[name] ?? name;
}

/** 笔刷分组显示名：只翻译内核默认分组。 */
export function displayBrushGroupName(group: string): string {
  return BRUSH_GROUPS[group] ?? group;
}
