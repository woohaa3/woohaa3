/**
 * U29 背景橡皮 / 魔术橡皮：按取样色擦除、按区域擦除、保护前景色、一步撤销。
 *
 * 成功标准来自 spec：背景擦除按取样色工作，魔术擦除按区域工作，保留无关前景并支持撤销。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U29 背景橡皮 / 魔术橡皮");

const hexAt = (session, x, y) => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};

/** 左半灰、右半蓝的测试底图。 */
const splitBackground = (session) => {
  session.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 24, height: 32, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({ x: 4, y: 4, color: "#808080", tolerance: 0, contiguous: true, opacity: 100 }));
  session.execute("select.rect", JSON.stringify({ x: 24, y: 0, width: 24, height: 32, mode: "replace" }));
  session.execute("paint.bucket", JSON.stringify({ x: 40, y: 4, color: "#0000ff", tolerance: 0, contiguous: true, opacity: 100 }));
  session.execute("select.all", "{}");
};

// ---- 魔术橡皮按区域擦除 ------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  splitBackground(session);
  const painted = session.contentHash();
  session.execute("paint.magicEraser", JSON.stringify({
    x: 8, y: 8, tolerance: 10, contiguous: true, antiAlias: false, opacity: 100, sampleAllLayers: false,
  }));
  const erased = hexAt(session, 8, 8);
  const kept = hexAt(session, 40, 8);
  session.execute("edit.undo", "{}");
  report.ok("魔术橡皮按区域擦除并保留无关前景", erased === null && kept === "#0000ff" && session.contentHash() === painted, {
    erased, kept,
  });
  session.free();
}

// ---- 背景橡皮按取样色擦除 ----------------------------------------------
// 用 `sampling:"once"`：只在起点取样，之后只擦与该取样色相近的像素，
// 所以笔迹扫过蓝色时蓝色不受影响。这是「按取样色工作」的判据。
{
  const session = newSession(mod, { width: 64, height: 32 });
  splitBackground(session);
  // 补一块蓝到一个会被笔迹扫过的位置，验证同一笔里蓝不被擦掉。
  session.execute("paint.stroke", JSON.stringify({ points: [[40, 4], [40, 28]], size: 8, color: "#0000ff" }));
  const painted = session.contentHash();
  session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[10, 16], [50, 16]], size: 8, hardness: 1, sampling: "once",
    limits: "contiguous", tolerance: 20, protectForegroundColor: false,
  }));
  const greyErased = hexAt(session, 12, 16);
  const blueKept = hexAt(session, 40, 16);
  session.execute("edit.undo", "{}");
  report.ok("背景橡皮按（一次）取样色擦除并保留其它颜色", greyErased === null && blueKept === "#0000ff"
    && session.contentHash() === painted, { greyErased, blueKept });
  session.free();
}

// ---- 连续取样会跟着笔迹换取样色 ----------------------------------------
// `sampling:"continuous"` 在笔迹移动中不断重取样，所以扫过蓝色时蓝色也会被擦。
// 这条把「两种取样模式的差别」钉住，否则上面那条断言可以被错误实现蒙对。
{
  const session = newSession(mod, { width: 64, height: 32 });
  splitBackground(session);
  session.execute("paint.stroke", JSON.stringify({ points: [[40, 4], [40, 28]], size: 8, color: "#0000ff" }));
  session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[10, 16], [50, 16]], size: 8, hardness: 1, sampling: "continuous",
    limits: "contiguous", tolerance: 20, protectForegroundColor: false,
  }));
  report.ok("连续取样下笔迹扫过的其它颜色也会被擦",
    hexAt(session, 12, 16) === null && hexAt(session, 40, 16) === null,
    { grey: hexAt(session, 12, 16), blue: hexAt(session, 40, 16) });
  session.free();
}

// ---- 保护前景色 --------------------------------------------------------
// 把前景色设成灰，用 protectForegroundColor 时应留下笔迹（不擦）。
{
  const session = newSession(mod, { width: 64, height: 64, background: "#000000" });
  session.execute("paint.bucket", JSON.stringify({ x: 4, y: 4, color: "#808080", tolerance: 255, contiguous: true, opacity: 100 }));
  session.execute("select.all", "{}");
  session.execute("paint.bucket", JSON.stringify({ x: 4, y: 4, color: "#808080", tolerance: 255, contiguous: true, opacity: 100 }));
  session.execute("tools.setColors", JSON.stringify({ foreground: "#808080" }));
  const painted = session.contentHash();

  session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[16, 16], [48, 16]], size: 10, hardness: 1, sampling: "continuous",
    limits: "discontiguous", tolerance: 20, protectForegroundColor: true,
  }));
  const protectedPixel = hexAt(session, 32, 16);
  session.execute("edit.undo", "{}");

  session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[16, 16], [48, 16]], size: 10, hardness: 1, sampling: "continuous",
    limits: "discontiguous", tolerance: 20, protectForegroundColor: false,
  }));
  const unprotectedPixel = hexAt(session, 32, 16);
  session.execute("edit.undo", "{}");
  report.ok("保护前景色时留下与前景同色的像素，取消保护后擦除", protectedPixel === "#808080" && unprotectedPixel === null, {
    protectedPixel, unprotectedPixel,
  });
  report.ok("背景橡皮用例后回到基线", session.contentHash() === painted);
  session.free();
}

// ---- 两个橡皮都是单步历史 ----------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  splitBackground(session);
  const base = session.contentHash();
  session.execute("paint.magicEraser", JSON.stringify({ x: 8, y: 8, tolerance: 10, contiguous: true, opacity: 100 }));
  const afterMagic = session.contentHash();
  session.execute("paint.backgroundEraser", JSON.stringify({
    points: [[30, 20], [44, 20]], size: 6, hardness: 1, sampling: "continuous",
    limits: "contiguous", tolerance: 20, protectForegroundColor: false,
  }));
  report.ok("两个橡皮连续两笔产生不同内容", session.contentHash() !== afterMagic && afterMagic !== base);
  session.execute("edit.undo", "{}");
  report.ok("撤销只回退背景橡皮那一笔", session.contentHash() === afterMagic);
  session.execute("edit.undo", "{}");
  report.ok("再撤销回基线", session.contentHash() === base);
  session.free();
}

report.finish();
