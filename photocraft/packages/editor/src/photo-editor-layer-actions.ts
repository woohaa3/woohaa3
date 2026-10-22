/** 图层面板与图层菜单共用的创建入口；新调整层从中性参数开始。 */
export const ADJUSTMENT_LAYER_ACTIONS = [
  { id: "layer.newAdjustmentLayer.brightnessContrast", label: "亮度/对比度", params: { brightness: 0, contrast: 0 } },
  { id: "layer.newAdjustmentLayer.curves", label: "曲线", params: { points: [[0, 0], [255, 255]] } },
  { id: "layer.newAdjustmentLayer.hueSaturation", label: "色相/饱和度", params: { hue: 0, saturation: 0, lightness: 0 } }
] as const;
