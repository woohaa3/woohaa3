/**
 * U34 吸管：平均采样尺寸、当前/全部/下方图层与前景/背景取样，且不改文档历史。
 *
 * 边界：`sampleColorOptions` 只**返回**颜色；把结果写回前景/背景色需要共享宿主提供
 * 可写色端口（见 verification.md 的阻塞项），所以这里验证的是「取色策略与源像素正确」，
 * 不假装面板已能把结果写回。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U34 吸管");

const sample = (session, params) => {
  const raw = session.sampleColorOptions(JSON.stringify({ size: "point", sampleLayer: "all", ...params }));
  return JSON.parse(raw);
};

// ---- 源像素与采样策略 --------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.execute("paint.bucket", JSON.stringify({
    x: 4, y: 4, color: "#123456", tolerance: 255, contiguous: true, opacity: 100,
  }));
  const base = session.contentHash();
  const point = sample(session, { x: 10, y: 10 });
  const averaged = sample(session, { x: 10, y: 10, size: 5 });
  const current = sample(session, { x: 10, y: 10, sampleLayer: "current" });
  report.ok("吸管按源像素取色（点采样/平均采样/当前层一致）",
    point?.hex === "#123456" && averaged?.hex === "#123456" && current?.hex === "#123456",
    { point: point?.hex, averaged: averaged?.hex, current: current?.hex });
  report.ok("取色不改变文档内容与历史", session.contentHash() === base);
  session.free();
}

// ---- 图外与透明 --------------------------------------------------------
{
  const session = newSession(mod, { width: 16, height: 16, background: "transparent" });
  report.ok("透明区域与图外采样返回空", sample(session, { x: 0, y: 0 }) === null
    && sample(session, { x: 1000, y: 10 }) === null);
  session.free();
}

// ---- 非法采样尺寸被拒绝 ------------------------------------------------
// `SAMPLE_SIZES` 只允许 point/3/5/…；随手写 4 必须拒绝，否则「平均采样」名不副实。
{
  const session = newSession(mod, { width: 32, height: 24 });
  let rejected = false;
  try {
    session.sampleColorOptions(JSON.stringify({ x: 4, y: 4, size: 4 }));
  } catch {
    rejected = true;
  }
  report.ok("非法采样尺寸被拒绝", rejected);
  session.free();
}

// ---- 多图层取样策略 ----------------------------------------------------
// 「下方图层」在单层文档里等价于当前层；关键是不同策略都必须返回同一个真实源像素，
// 而不是读显示缩略图。
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.execute("paint.bucket", JSON.stringify({
    x: 2, y: 2, color: "#204080", tolerance: 255, contiguous: true, opacity: 100,
  }));
  const results = ["current", "all", "currentAndBelow"].map((sampleLayer) => sample(session, { x: 8, y: 8, sampleLayer }));
  report.ok("当前层/全部/当前及以下策略都返回真实源像素",
    results.every((entry) => entry === null || entry?.hex === "#204080") && results.some((entry) => entry?.hex === "#204080"),
    { results: results.map((entry) => entry?.hex ?? null) });
  session.free();
}

// ---- 平均采样跨越色块边界 ----------------------------------------------
// 5×5 采样跨越黑白边界时结果应是中间值，而不是任一端的纯色；这是「平均」的实质。
{
  const session = newSession(mod, { width: 32, height: 24, background: "#000000" });
  session.execute("select.rect", JSON.stringify({ x: 16, y: 0, width: 16, height: 24, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({
    x: 20, y: 8, color: "#ffffff", tolerance: 0, contiguous: true, opacity: 100,
  }));
  session.execute("select.all", "{}");
  const averaged = sample(session, { x: 16, y: 12, size: 5 });
  const value = averaged === null ? null : parseInt(averaged.hex.slice(1, 3), 16);
  report.ok("5×5 平均采样跨边界得到中间值", value !== null && value > 20 && value < 235, { averaged: averaged?.hex, value });
  session.free();
}

report.finish();
