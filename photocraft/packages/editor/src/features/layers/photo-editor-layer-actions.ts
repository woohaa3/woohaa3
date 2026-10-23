/**
 * 图层面板与图层菜单共用的创建入口；新调整层从一组**明确的起点参数**开始
 * （色阶/曝光/色彩平衡等取恒等值；色调分离、阈值、照片滤镜、反相、通道混合器按定义
 * 一建出来就会改变画面，不宣称恒等）。
 *
 * 这里列出本域实现的**全部**逐类调整（与 `direct_adjustment::ADJUSTMENT_KINDS` 同一套后缀）；
 * 是否显示/可点仍由唯一命令门决定（`commands.get(id)?.allowed`），所以这不是第二份白名单：
 * 未开放的类型只会被过滤掉，不会造成「点了才失败」的菜单占位。
 */
export const ADJUSTMENT_LAYER_ACTIONS = [
  { id: "layer.newAdjustmentLayer.brightnessContrast", label: "亮度/对比度", params: { brightness: 0, contrast: 0 } },
  { id: "layer.newAdjustmentLayer.curves", label: "曲线", params: { points: [[0, 0], [255, 255]] } },
  { id: "layer.newAdjustmentLayer.hueSaturation", label: "色相/饱和度", params: { hue: 0, saturation: 0, lightness: 0 } },
  { id: "layer.newAdjustmentLayer.levels", label: "色阶", params: { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 } },
  { id: "layer.newAdjustmentLayer.vibrance", label: "自然饱和度", params: { vibrance: 0, saturation: 0 } },
  { id: "layer.newAdjustmentLayer.blackWhite", label: "黑白", params: { reds: 40, yellows: 40, greens: 40, cyans: 40, blues: 40, magentas: 40 } },
  // U43：九类新增逐类调整（中性参数即恒等，不会在创建时改变画面）。
  { id: "layer.newAdjustmentLayer.exposure", label: "曝光度", params: { exposure: 0, offset: 0, gamma: 1 } },
  {
    id: "layer.newAdjustmentLayer.colorBalance",
    label: "色彩平衡",
    params: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }
  },
  { id: "layer.newAdjustmentLayer.photoFilter", label: "照片滤镜", params: { filter: "warming85", density: 25 } },
  {
    id: "layer.newAdjustmentLayer.channelMixer",
    label: "通道混合器",
    params: { red: [40, 40, 20, 0], green: [30, 60, 10, 0], blue: [20, 20, 60, 0], monochrome: false }
  },
  { id: "layer.newAdjustmentLayer.invert", label: "反相", params: {} },
  { id: "layer.newAdjustmentLayer.posterize", label: "色调分离", params: { levels: 4 } },
  { id: "layer.newAdjustmentLayer.threshold", label: "阈值", params: { level: 128 } },
  {
    id: "layer.newAdjustmentLayer.gradientMap",
    label: "渐变映射",
    params: { stops: [[0, "#000000"], [1, "#ffffff"]], reverse: false, dither: true }
  },
  {
    id: "layer.newAdjustmentLayer.selectiveColor",
    label: "可选颜色",
    params: {
      method: "relative",
      reds: [0, 0, 0, 0], yellows: [0, 0, 0, 0], greens: [0, 0, 0, 0], cyans: [0, 0, 0, 0],
      blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0], whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 0]
    }
  }
] as const;
