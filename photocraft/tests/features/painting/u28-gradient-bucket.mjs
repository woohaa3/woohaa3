/**
 * U28 渐变 / 油漆桶：端点、色标、插值方式、平滑度、选区与连通域。
 *
 * 成功标准来自 spec：渐变端点与色标作用于真实源坐标；桶填充尊重连通域、选区与采样策略，
 * 与「整层前背景填充」有区别。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U28 渐变 / 油漆桶");

const hexAt = (session, x, y) => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};

// ---- 端点与色标 --------------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("paint.gradient", JSON.stringify({
    from: [0, 16], to: [47, 16], style: "linear", stops: [[0, "#000000"], [1, "#ffffff"]],
    opacity: 100, dither: false, reverse: false, mode: "normal",
  }));
  const start = hexAt(session, 1, 16);
  const end = hexAt(session, 46, 16);
  report.ok("渐变端点在源坐标上生效（起暗终亮）", start !== null && end !== null && start !== end, { start, end });

  // reverse 必须真的翻转色带方向：正向起点暗、终点亮，反向相反。
  // （不比较端点像素是否逐点相等：采样位置相对渐变跨度不对称，差 1 个灰度不代表没翻转。）
  const flipped = newSession(mod, { width: 48, height: 32 });
  flipped.execute("paint.gradient", JSON.stringify({
    from: [0, 16], to: [47, 16], style: "linear", stops: [[0, "#000000"], [1, "#ffffff"]],
    opacity: 100, dither: false, reverse: true, mode: "normal",
  }));
  const flipStart = hexAt(flipped, 1, 16);
  const flipEnd = hexAt(flipped, 46, 16);
  const luma = (hex) => (hex === null ? null : parseInt(hex.slice(1, 3), 16));
  report.ok("reverse 翻转渐变方向",
    luma(start) < luma(end) && luma(flipStart) > luma(flipEnd),
    { start, end, flipStart, flipEnd });
  session.free();
  flipped.free();
}

// ---- 插值方式与平滑度 --------------------------------------------------
// 用宽画布拉开色带：不同插值曲线在中段差异最明显。
{
  const session = newSession(mod, { width: 256, height: 16 });
  const base = session.contentHash();
  const xs = [16, 128, 240];
  const sampleWith = (params) => {
    session.execute("paint.gradient", JSON.stringify({
      from: [0, 8], to: [255, 8], style: "linear", dither: false,
      stops: [[0, "#000000"], [1, "#ffffff"]], ...params,
    }));
    const values = xs.map((x) => hexAt(session, x, 8));
    session.execute("edit.undo", "{}");
    if (session.contentHash() !== base) throw new Error("撤销未回基线");
    return values;
  };

  const plain = sampleWith({});
  const classic = sampleWith({ method: "classic", smoothness: 100 });
  const perceptual = sampleWith({ method: "perceptual", smoothness: 100 });
  const linear = sampleWith({ method: "linear" });
  report.ok("直线色标与 classic 得到不同像素", JSON.stringify(plain) !== JSON.stringify(classic), { plain, classic });
  report.ok("classic 与 perceptual 得到不同像素", JSON.stringify(classic) !== JSON.stringify(perceptual), {
    classic, perceptual,
  });
  report.ok("linear 与 classic 得到不同像素", JSON.stringify(classic) !== JSON.stringify(linear), { classic, linear });

  // 平滑度对 classic/perceptual/linear 有效；smooth 分支在内核 `eval` 里根本不读 smoothness，
  // 所以那条断言必须写成「无影响」，否则就是把内核语义当成域缺陷。
  for (const method of ["classic", "perceptual", "linear"]) {
    const low = sampleWith({ method, smoothness: 0 });
    const high = sampleWith({ method, smoothness: 100 });
    report.ok(`smoothness 对 ${method} 有影响`, JSON.stringify(low) !== JSON.stringify(high), { low, high });
  }
  {
    const low = sampleWith({ method: "smooth", smoothness: 0 });
    const high = sampleWith({ method: "smooth", smoothness: 100 });
    report.ok("smoothness 对 smooth 无影响（内核平滑分支不读该参数）", JSON.stringify(low) === JSON.stringify(high), { low });
  }

  // 内核**接受**未知 method 并静默退回直线色标，因此拒绝只能由域校验器（buildGradient→null）负责。
  // 这里把内核行为钉住，防止有人误以为「内核会拦住」。
  let kernelAccepted = false;
  try {
    session.execute("paint.gradient", JSON.stringify({
      from: [0, 8], to: [255, 8], stops: [[0, "#000000"], [1, "#ffffff"]], method: "bogus",
    }));
    kernelAccepted = true;
  } catch {
    kernelAccepted = false;
  }
  session.execute("edit.undo", "{}");
  report.ok("内核接受未知 method（拒绝责任在域校验器）", kernelAccepted);
  report.ok("渐变用例后回到基线", session.contentHash() === base);
  session.free();
}

// ---- 油漆桶尊重选区 ----------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 16, height: 16, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({
    x: 8, y: 8, color: "#00ff00", tolerance: 0, contiguous: true, opacity: 100,
  }));
  const inside = hexAt(session, 8, 8);
  const outside = hexAt(session, 30, 20);
  report.ok("油漆桶尊重选区（选区外不填）", inside === "#00ff00" && outside === "#ffffff", { inside, outside });
  session.free();
}

// ---- 连通域 ------------------------------------------------------------
// 分割线必须整幅贯穿，否则上下绕行会让两侧仍然连通，测试就测不到 contiguous。
{
  const divider = [[10, -4], [10, 36]];
  const contig = newSession(mod, { width: 48, height: 32 });
  contig.execute("paint.stroke", JSON.stringify({ points: divider, size: 3, color: "#000000" }));
  contig.execute("paint.bucket", JSON.stringify({
    x: 4, y: 16, color: "#ff0000", tolerance: 0, contiguous: true, opacity: 100,
  }));
  const left = hexAt(contig, 4, 16);
  const right = hexAt(contig, 40, 16);

  const loose = newSession(mod, { width: 48, height: 32 });
  loose.execute("paint.stroke", JSON.stringify({ points: divider, size: 3, color: "#000000" }));
  loose.execute("paint.bucket", JSON.stringify({
    x: 4, y: 16, color: "#ff0000", tolerance: 0, contiguous: false, opacity: 100,
  }));
  const looseRight = hexAt(loose, 40, 16);
  report.ok("油漆桶区分连通域（contiguous 不越过分割线）", left === "#ff0000" && right === "#ffffff" && looseRight === "#ff0000", {
    left, right, looseRight,
  });
  contig.free();
  loose.free();
}

// ---- 与整层填充不同 ----------------------------------------------------
// spec 要求桶填充区别于「整层前/背景填充」：同一坐标换容差会得到不同覆盖范围。
{
  const session = newSession(mod, { width: 48, height: 32, background: "#808080" });
  // 造一块白色区域，用容差 0 的桶只填白色区域。
  session.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 16, height: 16, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({ x: 4, y: 4, color: "#ffffff", tolerance: 0, contiguous: true, opacity: 100 }));
  session.execute("select.all", "{}");
  const before = session.contentHash();
  session.execute("paint.bucket", JSON.stringify({ x: 8, y: 8, color: "#00ff00", tolerance: 0, contiguous: true, opacity: 100 }));
  const inWhite = hexAt(session, 8, 8);
  const inGrey = hexAt(session, 30, 20);
  session.execute("edit.undo", "{}");
  report.ok("容差 0 的桶只改目标色块，不等于整层填充", inWhite === "#00ff00" && inGrey === "#808080" && session.contentHash() === before, {
    inWhite, inGrey,
  });
  session.free();
}

report.finish();
