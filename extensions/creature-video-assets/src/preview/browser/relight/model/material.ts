export interface RelightMaterialSettings {
  isGbufferEnabled: boolean;
  roughness: number;
  metallic: number;
  specularIntensity: number;
  normalStrength: number;
  deLightStrength: number;
  /** G-buffer 逆渲染本色替换原始 RGB 的比例；只有节肢动物发布了 albedo 页。 */
  albedoStrength: number;
  /** 逐像素深度自阴影强度；只有节肢动物发布了 depth 页。 */
  depthShadowStrength: number;
}
