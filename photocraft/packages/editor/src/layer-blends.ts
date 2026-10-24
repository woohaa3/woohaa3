import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
export const BLEND_LABELS: Record<string, string> = {"Normal": "正常", "Dissolve": "溶解", "Darken": "变暗", "Multiply": "正片叠底", "Color Burn": "颜色加深", "Linear Burn": "线性加深", "Darker Color": "深色", "Lighten": "变亮", "Screen": "滤色", "Color Dodge": "颜色减淡", "Linear Dodge (Add)": "线性减淡（添加）", "Lighter Color": "浅色", "Overlay": "叠加", "Soft Light": "柔光", "Hard Light": "强光", "Vivid Light": "亮光", "Linear Light": "线性光", "Pin Light": "点光", "Hard Mix": "实色混合", "Difference": "差值", "Exclusion": "排除", "Subtract": "减去", "Divide": "划分", "Hue": "色相", "Saturation": "饱和度", "Color": "颜色", "Luminosity": "明度", "Pass Through": "穿透" };

export function cycleBlend(mode:string,direction:-1|1,group=false):string {
  const choices:readonly string[]=group?["Pass Through",...PHOTOSHOP_BLENDS]:PHOTOSHOP_BLENDS;
  const index=choices.findIndex(choice=>choice.toLowerCase()===mode.toLowerCase());
  return choices[(Math.max(0,index)+direction+choices.length)%choices.length];
}
