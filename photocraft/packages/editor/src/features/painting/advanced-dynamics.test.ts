/**
 * U30 高级笔刷动态的域内回归
 * （change: 2026-10-22-add-photocraft-painting-color-workflows）。
 *
 * 锁住三件事：
 *
 * 1. **混合模式真的进了命令**：`paint.stroke` 的顶层 `mode` 来自用户选择，未知值拒绝而不是
 *    悄悄退回 `normal`（否则「界面显示叠加、实际正常」会通过验收）；
 * 2. **纹理/颜色/角度/圆度/双轴散布/数量抖动/曲线都编译进 `brush` 补丁**，命名与内核
 *    `BrushSettings` 的 camelCase 字段一致；
 * 3. **采样图案不被覆盖**：界面在 `custom` 图案下不重发 `texture.pattern`。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DYNAMICS, dynamicsFromBrush, dynamicsPatch } from "./brush-library-state.js";
import { PAINT_BLEND_MODES, isPaintBlendMode, normalizePaintBlendMode } from "./blend-modes.js";
import { formatCurvePoints, isLinearCurve, parseCurvePoints } from "./curve-points.js";
import { DEFAULT_BRUSH, buildStroke } from "./tool-parameters.js";
import { mergeBrushPatch } from "./paint-tool-state.js";

describe("U30 绘画混合模式", () => {
  it("模式进入 paint.stroke 顶层参数，默认仍是 normal", () => {
    expect(buildStroke([{ x: 1, y: 1 }], DEFAULT_BRUSH)!.mode).toBe("normal");
    const multiply = buildStroke([{ x: 1, y: 1 }], { ...DEFAULT_BRUSH, mode: "colorDodge" })!;
    expect(multiply.mode).toBe("colorDodge");
    // 模式不是 brush 补丁的一部分。
    const dynamics = mergeBrushPatch(DEFAULT_BRUSH, { mode: "screen" });
    expect(dynamics.mode).toBe("screen");
    expect(dynamics.dynamics).toBeUndefined();
    expect(buildStroke([{ x: 1, y: 1 }], dynamics)!.brush).toBeUndefined();
  });

  it("未知模式整笔拒绝，而不是退回 normal", () => {
    expect(buildStroke([{ x: 1, y: 1 }], { ...DEFAULT_BRUSH, mode: "swirl" as never })).toBeNull();
  });

  it("清单与内核标签互相归一化", () => {
    expect(isPaintBlendMode("multiply")).toBe(true);
    expect(isPaintBlendMode("passThrough")).toBe(false);
    expect(isPaintBlendMode("clear")).toBe(false);
    for (const mode of PAINT_BLEND_MODES) expect(normalizePaintBlendMode(mode)).toBe(mode);
    expect(normalizePaintBlendMode("Color Dodge")).toBe("colorDodge");
    expect(normalizePaintBlendMode("ColorBurn")).toBe("colorBurn");
    expect(normalizePaintBlendMode("Passthrough")).toBeNull();
    expect(normalizePaintBlendMode(7)).toBeNull();
  });
});

describe("U30 动态编译", () => {
  it("纹理、颜色动态、角度/圆度、双轴散布与数量抖动都进入补丁", () => {
    const patch = dynamicsPatch({
      ...DEFAULT_DYNAMICS,
      textureEnabled: true,
      textureStyle: "canvas",
      textureScale: 2.5,
      textureInvert: true,
      textureMode: "linearHeight",
      textureDepth: 0.4,
      colorDynamicsEnabled: true,
      colorPerTip: false,
      fgBgJitter: 0.5,
      fgBgControl: "penPressure",
      hueJitter: 0.2,
      saturationJitter: 0.1,
      brightnessJitter: 0.3,
      purity: -0.5,
      angleJitter: 0.25,
      angleControl: "direction",
      roundnessJitter: 0.4,
      roundnessControl: "penTilt",
      roundnessMinimum: 0.2,
      scatterBothAxes: true,
      scatterJitter: 0.6,
      scatterMinimum: 0.1
    }) as Record<string, Record<string, unknown>>;
    const texture = patch.texture as Record<string, unknown>;
    expect(texture.enabled).toBe(true);
    expect(texture.pattern).toEqual({ procedural: { style: "canvas", size: 128, seed: 1 } });
    expect(texture.scale).toBe(2.5);
    expect(texture.invert).toBe(true);
    expect(texture.mode).toBe("linearHeight");
    expect(texture.depth).toBe(0.4);

    const color = patch.colorDynamics as Record<string, unknown>;
    expect(color.enabled).toBe(true);
    expect(color.perTip).toBe(false);
    expect(color.hueJitter).toBe(0.2);
    expect(color.saturationJitter).toBe(0.1);
    expect(color.brightnessJitter).toBe(0.3);
    expect(color.purity).toBe(-0.5);
    expect((color.fgBg as Record<string, unknown>).control).toBe("penPressure");

    const shape = patch.shapeDynamics as Record<string, Record<string, unknown>>;
    expect(shape.enabled).toBe(true);
    expect(shape.angle).toMatchObject({ jitter: 0.25, control: "direction" });
    expect(shape.roundness).toMatchObject({ jitter: 0.4, control: "penTilt", minimum: 0.2 });

    const scattering = patch.scattering as Record<string, unknown>;
    expect(scattering.bothAxes).toBe(true);
    expect(scattering.countJitter).toMatchObject({ jitter: 0.6, minimum: 0.1 });
  });

  it("采样图案（custom）不重发 pattern，程序化样式才写", () => {
    const custom = dynamicsPatch({ ...DEFAULT_DYNAMICS, textureEnabled: true, textureStyle: "custom" }) as Record<string, Record<string, unknown>>;
    expect("pattern" in (custom.texture as Record<string, unknown>)).toBe(false);
    const paper = dynamicsPatch({ ...DEFAULT_DYNAMICS, textureStyle: "paper" }) as Record<string, Record<string, unknown>>;
    expect((paper.texture as Record<string, unknown>).pattern).toEqual({ procedural: { style: "paper", size: 128, seed: 1 } });
  });

  it("折叠内核设置时识别采样图案与未知掩膜模式", () => {
    const folded = dynamicsFromBrush({
      texture: { enabled: true, pattern: { tile: { width: 8, height: 8 } }, mode: "nonsense" },
      shapeDynamics: { angle: { jitter: 0.3, control: "rotation" } }
    });
    expect(folded.textureStyle).toBe("custom");
    expect(folded.textureMode).toBe("multiply");
    expect(folded.angleControl).toBe("rotation");
    // 未知控制器不猜，读作关。
    expect(dynamicsFromBrush({ shapeDynamics: { angle: { control: "telepathy" } } }).angleControl).toBe("off");
  });

  it("预览往返不把采样纹理换成默认纸纹", () => {
    // 自己发出的 custom 补丁没有 pattern 字段：再折叠回来必须还是 custom，否则预览会改图案。
    const custom = dynamicsFromBrush({ texture: { enabled: true } });
    expect(custom.textureStyle).toBe("custom");
    const roundTrip = dynamicsFromBrush(dynamicsPatch(custom) as unknown as Record<string, unknown>);
    expect(roundTrip.textureStyle).toBe("custom");
    expect(roundTrip.textureEnabled).toBe(true);
    // 真正没有纹理段的笔刷仍取默认（纸纹），不是被误判成采样图案。
    expect(dynamicsFromBrush({ size: 20 }).textureStyle).toBe("paper");
  });

  it("响应曲线只在合法时写入补丁", () => {
    const curve: [number, number][] = [[0, 0], [0.5, 0.2], [1, 1]];
    const patch = dynamicsPatch({ ...DEFAULT_DYNAMICS, sizeCurve: curve }) as Record<string, Record<string, Record<string, unknown>>>;
    expect(patch.shapeDynamics!.size!.curve).toEqual(curve);
    // 空曲线不写字段（保留内核当前曲线，允许「不做修改」与「恢复线性」区分）。
    const plain = dynamicsPatch({ ...DEFAULT_DYNAMICS }) as Record<string, Record<string, Record<string, unknown>>>;
    expect("curve" in plain.shapeDynamics!.size!).toBe(false);
  });
});

describe("U30 响应曲线文本", () => {
  it("解析合法点集并规范化", () => {
    expect(parseCurvePoints("0,0; 0.5,0.2; 1,1")).toEqual([[0, 0], [0.5, 0.2], [1, 1]]);
    expect(parseCurvePoints("0，0；1，1")).toEqual([[0, 0], [1, 1]]);
    expect(formatCurvePoints([[0, 0], [1, 1]])).toBe("0,0; 1,1");
    expect(isLinearCurve([[0, 0], [1, 1]])).toBe(true);
    expect(isLinearCurve([[0, 0], [1, 0.5]])).toBe(false);
    expect(isLinearCurve([])).toBe(true);
  });

  it("拒绝空串、非法数字、越界、乱序与超量", () => {
    expect(parseCurvePoints("")).toBeNull();
    expect(parseCurvePoints("0,0")).toBeNull();
    expect(parseCurvePoints("0,0; 1")).toBeNull();
    expect(parseCurvePoints("0,0; 1,2")).toBeNull();
    expect(parseCurvePoints("0,0; 0.5,0.2; 0.5,0.3; 1,1")).toBeNull();
    expect(parseCurvePoints("0,0; 0.5,0.2; 0.4,0.3; 1,1")).toBeNull();
    const many = Array.from({ length: 18 }, (_, index) => `${index / 17},${index / 17}`).join("; ");
    expect(parseCurvePoints(many)).toBeNull();
  });
});
