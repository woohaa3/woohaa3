/**
 * U27 铅笔 / 颜色替换：颜色、硬边、匹配范围与「逐工具设置互不串改」。
 *
 * 成功标准来自 spec：铅笔按前景色画硬边；颜色替换只改匹配色、保留无关像素；
 * 两个工具各自的笔迹尺寸独立生效。全部在真实内核上取像素验证。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U27 铅笔 / 颜色替换");

/** 与 `buildPencil` 编译出的参数同形（hardness=1、flow=1、opacity=1、spacing 0.05）。 */
const pencil = (session, color, size = 6) =>
  session.execute("paint.pencil", JSON.stringify({
    points: [[8, 16], [40, 16]], size, color, mode: "normal", autoErase: false, zoom: 1,
    brush: { hardness: 1, spacing: 0.05, smoothing: { enabled: false, amount: 0 }, flow: 1, opacity: 1 },
    target: "pixels",
  }));

const replaceColor = (session, size, extra = {}) =>
  session.execute("paint.colorReplacement", JSON.stringify({
    points: [[12, 12], [36, 12]], size, color: "#ff0000", mode: "color",
    tolerance: 100, sampling: "continuous", limits: "discontiguous", antiAlias: false,
    target: "pixels", ...extra,
  }));

const hexAt = (session, x, y) => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};

// ---- 铅笔颜色跟随前景色 ------------------------------------------------
{
  const session = newSession(mod, { width: 64, height: 32 });
  const base = session.contentHash();

  pencil(session, "#00ff00");
  report.ok("铅笔按传入的前景色落笔（绿）", hexAt(session, 8, 16) === "#00ff00" && hexAt(session, 40, 16) === "#00ff00", {
    hex: hexAt(session, 8, 16),
  });
  const greenHash = session.contentHash();
  report.ok("落笔推进内容指纹", greenHash !== base);
  session.execute("edit.undo", "{}");
  report.ok("一步撤销回到基线", session.contentHash() === base && hexAt(session, 8, 16) === "#ffffff");

  // 回归点：面板曾把铅笔写死成 DEFAULT_PENCIL.color(#000000)，换前景色不产生任何差异。
  pencil(session, "#000000");
  report.ok("同一路径换前景色得到不同像素", hexAt(session, 8, 16) === "#000000" && greenHash !== session.contentHash(), {
    hex: hexAt(session, 8, 16),
  });
  session.execute("edit.undo", "{}");

  // 硬边：中心与边缘同为纯色，没有软边过渡。
  pencil(session, "#ff0000");
  const edge = [13, 14, 15, 16].map((y) => hexAt(session, 24, y));
  report.ok("硬边笔尖：中心与边缘同为纯色", edge.every((value) => value === "#ff0000"), { edge });
  session.execute("edit.undo", "{}");
  report.ok("全部用例后回到基线", session.contentHash() === base);
  session.free();
}

// ---- 颜色替换只改匹配色 ------------------------------------------------
{
  const session = newSession(mod, { width: 64, height: 32, background: "#808080" });
  // 先放一块蓝，作为「不匹配色」的对照。
  session.execute("paint.stroke", JSON.stringify({ points: [[30, 24], [44, 24]], size: 6, color: "#0000ff" }));
  const blueHash = session.contentHash();
  replaceColor(session, 20);
  const replaced = hexAt(session, 12, 12);
  const keptBlue = hexAt(session, 37, 24);
  // `mode:"color"` 只搬色相/饱和度、保留目标亮度，所以灰 (#808080) 变红后是 #ff4a4a。
  const redDominant = replaced !== null
    && parseInt(replaced.slice(1, 3), 16) > parseInt(replaced.slice(3, 5), 16)
    && parseInt(replaced.slice(1, 3), 16) > parseInt(replaced.slice(5, 7), 16);
  session.execute("edit.undo", "{}");
  report.ok("颜色替换只改匹配色并保留无关颜色", redDominant && keptBlue === "#0000ff" && session.contentHash() === blueHash, {
    replaced, keptBlue,
  });
  session.free();
}

// ---- 颜色替换跳过不匹配像素 --------------------------------------------
{
  const session = newSession(mod, { width: 64, height: 32 });
  session.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 32, height: 32, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({ x: 4, y: 4, color: "#808080", tolerance: 0, contiguous: true, opacity: 100 }));
  session.execute("select.all", "{}");
  const before = session.contentHash();
  replaceColor(session, 20);
  const grey = hexAt(session, 12, 12);
  const white = hexAt(session, 50, 20);
  session.execute("edit.undo", "{}");
  report.ok("颜色替换跳过不匹配像素（白底不动）", grey === "#ff4a4a" && white === "#ffffff" && session.contentHash() === before, {
    grey, white,
  });
  session.free();
}

// ---- 逐工具笔迹尺寸独立 ------------------------------------------------
// 面板曾把颜色替换的尺寸绑到背景橡皮的 size，改一个另一个跟着变；这里按列统计着色宽度区分。
{
  const session = newSession(mod, { width: 96, height: 48, background: "#808080" });
  const base = session.contentHash();
  const columns = (x) => {
    let count = 0;
    for (let y = 0; y < 48; y += 1) if (hexAt(session, x, y) !== "#808080") count += 1;
    return count;
  };
  const colorStroke = (size) => session.execute("paint.colorReplacement", JSON.stringify({
    points: [[12, 24], [84, 24]], size, color: "#ff0000", mode: "color",
    tolerance: 100, sampling: "continuous", limits: "discontiguous", antiAlias: false, target: "pixels",
  }));
  const eraseStroke = (size) => session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[48, 24]], size, hardness: 1, sampling: "continuous", limits: "discontiguous",
    tolerance: 100, protectForegroundColor: false,
  }));

  colorStroke(4); const thin = columns(48); session.execute("edit.undo", "{}");
  colorStroke(20); const thick = columns(48); session.execute("edit.undo", "{}");
  report.ok("颜色替换：size 4 与 20 的着色宽度不同", thin > 0 && thick > thin, { thin, thick });
  report.ok("颜色替换撤销后回到基线", session.contentHash() === base);

  eraseStroke(4); const eraseThin = columns(48); session.execute("edit.undo", "{}");
  eraseStroke(20); const eraseThick = columns(48); session.execute("edit.undo", "{}");
  report.ok("背景橡皮：size 4 与 20 的擦除宽度不同", eraseThin > 0 && eraseThick > eraseThin, {
    eraseThin, eraseThick,
  });
  report.ok("背景橡皮撤销后回到基线", session.contentHash() === base);

  colorStroke(8);
  const afterColor = session.contentHash();
  eraseStroke(8);
  report.ok("两个工具连续两笔产生不同内容", session.contentHash() !== afterColor);
  session.execute("edit.undo", "{}");
  report.ok("撤销只回退背景橡皮那一笔", session.contentHash() === afterColor);
  session.execute("edit.undo", "{}");
  report.ok("再撤销回基线", session.contentHash() === base);
  session.free();
}

report.finish();
