/** 图层创建入口与调整域实现的类型清单互锁；只查结构，不渲染。 */
import { expect, it } from "vitest";
import { ADJUSTMENT_KINDS, ADJUSTMENT_LABELS, defaultAdjustmentParams } from "./tool-parameters.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "../layers/photo-editor-layer-actions.js";

/**
 * 这两类的入口参数就是恒等参数（新建后不改变画面），必须与直接调整的中性参数同源；
 * 其余类型的入口按定义就会改画面（黑白一定去色、色调分离/阈值/反相/渐变映射重映射、
 * 照片滤镜着色、通道混合器按权重重算），不能宣称恒等。
 */
const IDENTITY_START = ["brightnessContrast", "exposure", "hueSaturation", "curves", "levels", "colorBalance", "vibrance"] as const;

it("调整图层动作覆盖全部已实现类型，标识与标签不重复也不缺项", () => {
  // 每类已实现调整都必须有创建入口，否则「调整层」这条路径会少类型；反过来也不能凭空多出类型。
  // 是否可点仍由唯一命令门决定（`commands.get(id)?.allowed`），这里只管清单完整性。
  const ids = ADJUSTMENT_LAYER_ACTIONS.map((action) => action.id);
  expect(ids).toHaveLength(ADJUSTMENT_KINDS.length);
  expect(new Set(ids).size).toBe(ids.length);
  for (const kind of ADJUSTMENT_KINDS) {
    const action = ADJUSTMENT_LAYER_ACTIONS.find((entry) => entry.id === `layer.newAdjustmentLayer.${kind}`);
    expect(action, kind).toBeDefined();
    expect(action!.label, kind).toBe(ADJUSTMENT_LABELS[kind]);
  }
});

it("恒等起点的类型与直接调整中性参数一致，其余类型给出非空起点", () => {
  for (const kind of ADJUSTMENT_KINDS) {
    const params = ADJUSTMENT_LAYER_ACTIONS.find((entry) => entry.id === `layer.newAdjustmentLayer.${kind}`)!.params as Record<string, unknown>;
    if ((IDENTITY_START as readonly string[]).includes(kind)) {
      // 同一个类型的起点只允许一份定义：直接调整的中性参数。
      for (const [key, value] of Object.entries(defaultAdjustmentParams(kind))) {
        expect(params, `${kind}.${key}`).toHaveProperty(key, value);
      }
      continue;
    }
    // 反相没有参数；其余必须给出完整起点，避免依赖内核隐含默认值。
    if (kind === "invert") expect(params).toEqual({});
    else expect(Object.keys(params).length, kind).toBeGreaterThan(0);
  }
});
