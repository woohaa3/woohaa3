/**
 * U30 绘画混合模式、纹理/模式、颜色/角度/圆度动态、压力曲线与双轴散布/数量抖动。
 *
 * 关键判据来自 spec：切模式必须改变**实际像素**而不是只改控件值；固定轨迹/seed 下
 * 预览与落笔一致。所以这里只比较像素/内容指纹，绝不把「参数被接受」当作通过。
 */
import { createReport, loadKernel } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U30 高级笔刷动态");

// 中灰底：白底上 multiply/hue 等模式与 normal 结果相同（符合混合定义），无法区分「模式真的进了内核」。
const session = new mod.WasmEditor();
session.execute("file.new", JSON.stringify({ width: 48, height: 32, background: "#808080" }));
const base = session.contentHash();

const points = [[4, 16], [20, 10], [44, 22]];
/** 落一笔取 hash 再撤销；返回是否改变像素、是否一步撤销干净。 */
const stroke = (params) => {
  const before = session.contentHash();
  session.execute("paint.stroke", JSON.stringify({ points, size: 12, color: "#ff0000", seed: 7, ...params }));
  const after = session.contentHash();
  session.execute("edit.undo", "{}");
  const restored = session.contentHash();
  return { changed: after !== before, restored: restored === before, hash: after };
};

const normal = stroke({});
report.ok("普通笔迹改变像素并可一步撤销", normal.changed && normal.restored, {
  changed: normal.changed, restored: normal.restored,
});

// ---- 混合模式 ----------------------------------------------------------
{
  const modes = ["normal", "multiply", "colorDodge", "difference", "hue"];
  const hashes = new Map();
  for (const mode of modes) {
    const result = stroke({ mode });
    if (!result.restored) throw new Error(`mode ${mode} 撤销后 hash 不一致`);
    hashes.set(mode, result.hash);
  }
  report.ok("绘画混合模式改变真实像素（各模式 hash 互不相同）", new Set(hashes.values()).size === modes.length,
    Object.fromEntries([...hashes].map(([mode, hash]) => [mode, hash.slice(0, 12)])));
}

// ---- 纹理 --------------------------------------------------------------
{
  const texture = stroke({
    brush: {
      texture: { enabled: true, pattern: { procedural: { style: "canvas", size: 64, seed: 1 } }, scale: 2, mode: "multiply", depth: 0.8 },
    },
  });
  report.ok("纹理进入笔迹并改变像素", texture.changed && texture.restored, {
    changed: texture.changed, restored: texture.restored,
  });
}

// ---- 颜色动态 ----------------------------------------------------------
{
  const color = stroke({
    brush: {
      colorDynamics: {
        enabled: true, perTip: true, fgBg: { jitter: 0.5, control: "off", minimum: 0 },
        hueJitter: 0.4, saturationJitter: 0.2, brightnessJitter: 0.3, purity: 0,
      },
    },
  });
  report.ok("颜色动态改变像素", color.changed && color.restored);
}

// ---- 形状动态：角度/圆度 -----------------------------------------------
{
  const shape = stroke({
    brush: {
      shapeDynamics: {
        enabled: true,
        angle: { jitter: 0.6, control: "direction", minimum: 0 },
        roundness: { jitter: 0.5, control: "penTilt", minimum: 0.3 },
      },
    },
  });
  report.ok("角度/圆度动态改变像素", shape.changed && shape.restored);
}

// ---- 散布：双轴 + 数量抖动 ---------------------------------------------
{
  const scatter = stroke({
    brush: {
      scattering: {
        enabled: true, scatter: { jitter: 1.5, control: "off", minimum: 0 },
        bothAxes: true, count: 4, countJitter: { jitter: 0.5, control: "off", minimum: 0 },
      },
    },
  });
  report.ok("双轴散布/数量抖动改变像素", scatter.changed && scatter.restored);
}

// ---- 压力响应曲线 ------------------------------------------------------
// 必须带上压感点，否则 pressure 恒为 1 时曲线不起作用，测不到东西。
{
  const pressurePoints = [[4, 16, 0.4], [20, 10, 0.7], [44, 22, 0.25]];
  const hashOf = (brush) => {
    const before = session.contentHash();
    session.execute("paint.stroke", JSON.stringify({ points: pressurePoints, size: 24, color: "#ff0000", seed: 7, brush }));
    const hash = session.contentHash();
    session.execute("edit.undo", "{}");
    if (session.contentHash() !== before) throw new Error("撤销后 hash 不一致");
    return hash;
  };
  const linearCurve = hashOf({
    shapeDynamics: { enabled: true, size: { jitter: 0, control: "penPressure", minimum: 0, curve: [[0, 0], [1, 1]] } },
  });
  const shapedCurve = hashOf({
    shapeDynamics: { enabled: true, size: { jitter: 0, control: "penPressure", minimum: 0, curve: [[0, 0], [0.5, 0.05], [1, 0.2]] } },
  });
  // 同一控制器但不给 curve：内核按线性处理，应与显式线性一致。
  const defaultCurve = hashOf({
    shapeDynamics: { enabled: true, size: { jitter: 0, control: "penPressure", minimum: 0 } },
  });
  report.ok("压力响应曲线改变笔尖大小", linearCurve !== shapedCurve && linearCurve === defaultCurve, {
    linear: linearCurve.slice(0, 12), shaped: shapedCurve.slice(0, 12), default: defaultCurve.slice(0, 12),
  });
}

// ---- 预览与落笔一致 ----------------------------------------------------
// spec 要求固定轨迹/seed 下预览与落笔一致：预览不得写文档，且同样参数重复落笔得到同样结果。
{
  const preview = session.brushPreview(JSON.stringify({ brush: { size: 20, hardness: 0.4, scattering: { enabled: true, count: 3 } }, side: 64 }));
  report.ok("笔迹预览不写文档", session.contentHash() === base && preview.width === 64, { width: preview.width });

  // 必须让 seed 真正参与抖动：只开 `scattering.enabled` 而 scatter 抖动为 0 时，
  // 任何 seed 都得到同一像素（这是内核语义，测不到 seed 就没意义）。
  const scatterBrush = {
    scattering: {
      enabled: true, scatter: { jitter: 1.5, control: "off", minimum: 0 },
      bothAxes: true, count: 4, countJitter: { jitter: 0.5, control: "off", minimum: 0 },
    },
  };
  const first = stroke({ seed: 21, brush: scatterBrush });
  const second = stroke({ seed: 21, brush: scatterBrush });
  report.ok("同轨迹同 seed 重复落笔得到相同像素", first.hash === second.hash, {
    first: first.hash.slice(0, 12), second: second.hash.slice(0, 12),
  });
  const differentSeed = stroke({ seed: 22, brush: scatterBrush });
  report.ok("换 seed 得到不同像素", differentSeed.hash !== first.hash, {
    seed21: first.hash.slice(0, 12), seed22: differentSeed.hash.slice(0, 12),
  });

  let rejected = false;
  try {
    session.brushPreview(JSON.stringify({ brush: { mode: "bogus" }, side: 32 }));
  } catch {
    rejected = true;
  }
  report.ok("非法笔刷预览被拒绝", rejected);
}

// ---- 非法动态被拒绝 ----------------------------------------------------
{
  let rejected = false;
  try {
    session.execute("paint.stroke", JSON.stringify({
      points, size: 12, color: "#ff0000",
      brush: { scattering: { enabled: true, scatter: { jitter: 99, control: "off", minimum: 0 }, count: 3 } },
    }));
  } catch {
    rejected = true;
  }
  report.ok("超范围散布被拒绝（不静默按别的值画）", rejected);
  if (session.contentHash() !== base) session.execute("edit.undo", "{}");
  report.ok("全部用例后文档回到基线", session.contentHash() === base);
}

session.free();
report.finish();
