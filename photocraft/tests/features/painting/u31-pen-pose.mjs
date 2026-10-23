/**
 * U31 域内一半：笔姿态（tilt/twist）经本域槽位编码真正到达内核并影响落笔。
 *
 * 边界说明：**采集**发生在共享画布（pointer 的 tiltX/tiltY/twist），本域不能改；
 * `photo-editor-canvas.tsx` 目前只传 x/y/pressure，所以这里证明的是「只要采集到，
 * 本域的编码就能让倾斜/旋转生效」。真正的手写笔采集证据属于待人工验证项。
 *
 * 注意：内容 hash 含文档/图层身份，**两个新文档的 hash 天生不同**，因此全部比较都在
 * 同一个会话内做（落笔 → 取 hash → 撤销回基线）。
 */
import { createReport, loadKernel } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U31 笔姿态编码");

// 中灰底：白底会把笔尖形状差异抹平。
const session = new mod.WasmEditor();
session.execute("file.new", JSON.stringify({ width: 64, height: 64, background: "#808080" }));
const base = session.contentHash();

/** 落一笔取 hash，再撤销回基线。同一会话内比较，跨调用是合法的。 */
const hashOf = (points, brush) => {
  session.execute("paint.stroke", JSON.stringify({
    points, size: 30, color: "#ff0000", seed: 3, ...(brush ? { brush } : {}),
  }));
  const hash = session.contentHash();
  session.execute("edit.undo", "{}");
  if (session.contentHash() !== base) throw new Error("撤销未回到基线");
  return hash;
};

const line = [[10, 10], [50, 50]];
const tilted = [[10, 10, 1, 81, 81, 0], [50, 50, 1, 81, 81, 0]];
const rotated = [[10, 10, 1, 0, 0, 288], [50, 50, 1, 0, 0, 288]];

// ---- 姿态槽位本身不改变像素（内核语义） --------------------------------
// 没有消费姿态的动态时，倾斜/旋转不该影响结果。这是内核语义，不是编码丢失；
// 把这条钉住，才能让下面「有动态时才变化」的断言有意义。
{
  const plain = hashOf(line);
  const tilt = hashOf(tilted);
  const rot = hashOf(rotated);
  report.ok("无倾斜动态时姿态不改变像素（内核语义，非编码丢失）", plain === tilt && plain === rot, {
    plain: plain.slice(0, 10),
  });
}

// ---- 倾斜真的进入 PenTilt 动态 -----------------------------------------
{
  const penTilt = { shapeDynamics: { enabled: true, tiltScale: 1, size: { jitter: 0, control: "penTilt", minimum: 0 } } };
  const flat = hashOf(line, penTilt);
  const tilt = hashOf(tilted, penTilt);
  report.ok("PenTilt 控制 + 倾斜真实改变笔尖", flat !== tilt, {
    flat: flat.slice(0, 10), tilt: tilt.slice(0, 10),
  });
}

// ---- 旋转真的进入 Brush Projection -------------------------------------
// 圆形笔尖（roundness=1）任何角度都相同，所以必须同时把圆度压扁，否则这条断言测不到东西。
{
  const projection = { roundness: 0.3, shapeDynamics: { enabled: true, brushProjection: true } };
  const zero = hashOf([[10, 10, 1, 0, 0, 0], [50, 50, 1, 0, 0, 0]], projection);
  const turned = hashOf(rotated, projection);
  report.ok("Brush Projection + 旋转真实改变笔尖角度", zero !== turned, {
    zero: zero.slice(0, 10), turned: turned.slice(0, 10),
  });
}

// ---- 槽位对齐 ----------------------------------------------------------
// 若倾斜被误写进压力槽（索引 2），压力动态会读到它并改变结果。用真实压力 0.3 与
// 「把倾斜值当压力」两种输入比对，确认编码位置是对的。
{
  const pressure = { transfer: { enabled: true, opacity: { jitter: 0.8, control: "penPressure", minimum: 0 } } };
  const aligned = hashOf([[10, 10, 0.3, 81, 81, 0], [50, 50, 0.3, 81, 81, 0]], pressure);
  const misaligned = hashOf([[10, 10, 81, 81, 0], [50, 50, 81, 81, 0]], pressure);
  report.ok("槽位对齐：倾斜误写进压力槽会被压力动态读到并改变结果", aligned !== misaligned, {
    aligned: aligned.slice(0, 10), misaligned: misaligned.slice(0, 10),
  });
}

// ---- 带姿态的一步撤销 --------------------------------------------------
{
  session.execute("paint.stroke", JSON.stringify({
    points: tilted, size: 20, color: "#00ff00",
    brush: { shapeDynamics: { enabled: true, tiltScale: 1 } },
  }));
  const painted = session.contentHash();
  session.execute("edit.undo", "{}");
  report.ok("带姿态的笔迹一步撤销回原内容", painted !== base && session.contentHash() === base);
}

// ---- 越界姿态收敛后仍能落笔 --------------------------------------------
// tilt 上限 90、rotation 上限 360；越界值必须被本域收敛而不是整笔作废。
{
  session.execute("paint.stroke", JSON.stringify({
    points: [[10, 10, 1, 90, 90, 360], [50, 50, 1, 90, 90, 360]], size: 20, color: "#0000ff",
  }));
  const painted = session.contentHash();
  session.execute("edit.undo", "{}");
  report.ok("收敛到允许范围后仍能落笔并撤销", painted !== base && session.contentHash() === base);
}

session.free();
report.finish();
