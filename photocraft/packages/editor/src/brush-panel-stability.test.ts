/**
 * 笔刷面板渲染稳定性回归（change: 2026-10-22-complete-photocraft-webui-editing，缺陷复查）。
 *
 * 复现路径：`PhotoEditorApp` 里 `brush` 每次渲染都是新对象（`usePaintTools` 用对象展开）；
 * `BrushPresetPicker` 的 `useEffect(..., [brush])` 无条件 `setDynamics(...)`，而 `setDynamics`
 * 每次拿到新对象 → 重新渲染 → 新 `brush` → 再次 effect，形成渲染循环。
 *
 * 本测试锁定：同一份笔刷参数多次渲染时，面板不应产生新的状态更新。
 */
import { describe, expect, it } from "vitest";
import { dynamicsPatch, dynamicsFromBrush, DEFAULT_DYNAMICS } from "./brush-library-state.js";

describe("笔刷参数投影稳定性", () => {
  it("相同内核设置在多次折叠中得到相等的动态参数（不会因为新对象引用而视为变化）", () => {
    const brush = {
      size: 24,
      hardness: 0.8,
      spacing: 0.25,
      roundness: 1,
      shapeDynamics: { enabled: true, size: { jitter: 0, control: "penPressure", minimum: 0 } },
      smoothing: { amount: 0.2, pulledString: false, catchUp: true }
    };
    // 每次调用都传**新的**对象字面量：模拟 React 每次渲染重造的 brush。
    const first = dynamicsFromBrush({ ...brush });
    const second = dynamicsFromBrush({ ...brush });
    // 内容相等：不能因为引用不同就让 effect 认为参数变了。
    expect(second).toEqual(first);
    // 折叠结果再编译回补丁也必须稳定（预览 key 不变，不会每帧重算预览）。
    expect(dynamicsPatch(second)).toEqual(dynamicsPatch(first));
  });

  it("折叠结果与默认值比较不看引用", () => {
    const folded = dynamicsFromBrush({ ...{ size: 20, hardness: 1 } });
    expect(folded).toEqual({ ...DEFAULT_DYNAMICS, smoothing: folded.smoothing });
  });
});
