/**
 * U33 对称：水平/垂直/径向等模式、从路径定义/关闭，以及「一笔所有镜像同一事务」。
 *
 * 判据来自 spec：旋转/缩放视图后对称仍绕源坐标轴（视图变换不参与内核坐标，故此处验证
 * 内核侧的源坐标语义）；撤销一次移除整笔所有镜像。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U33 对称");

const hexAt = (session, x, y) => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};

// ---- 垂直对称：一笔两侧都有像素，一次撤销移除两边 ----------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("paint.setSymmetry", JSON.stringify({ mode: "vertical", center: [24, 16], rotation: 0 }));
  const state = JSON.parse(session.symmetryStateJson());
  const base = session.contentHash();
  session.execute("paint.stroke", JSON.stringify({ points: [[8, 10], [14, 20]], size: 4, color: "#ff0000" }));
  const original = hexAt(session, 11, 15);
  // center.x=24 → 镜像 x = 48 - 11 = 37
  const mirror = hexAt(session, 37, 15);
  session.execute("edit.undo", "{}");
  report.ok("垂直对称：一笔产生镜像，一次撤销移除两边",
    state.mode === "vertical" && original === "#ff0000" && mirror === "#ff0000" && session.contentHash() === base,
    { mode: state.mode, original, mirror });
  report.ok("关闭对称为未启用", (() => {
    session.execute("paint.symmetryDisable", "{}");
    return JSON.parse(session.symmetryStateJson()).enabled === false;
  })());
  session.free();
}

// ---- 水平对称 ----------------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("paint.setSymmetry", JSON.stringify({ mode: "horizontal", center: [24, 16], rotation: 0 }));
  session.execute("paint.stroke", JSON.stringify({ points: [[8, 6], [14, 9]], size: 4, color: "#0000ff" }));
  const original = hexAt(session, 11, 8);
  // center.y=16 → 镜像 y = 32 - 8 = 24
  const mirror = hexAt(session, 11, 24);
  report.ok("水平对称在源坐标上镜像", original === "#0000ff" && mirror === "#0000ff", { original, mirror });
  session.free();
}

// ---- 双轴/对角等模式可用 -----------------------------------------------
{
  for (const mode of ["dual", "diagonal"]) {
    const session = newSession(mod, { width: 48, height: 32 });
    const base = session.contentHash();
    let accepted = true;
    let detail;
    try {
      session.execute("paint.setSymmetry", JSON.stringify({ mode, center: [24, 16], rotation: 0 }));
      session.execute("paint.stroke", JSON.stringify({ points: [[10, 10], [16, 14]], size: 4, color: "#ff0000" }));
    } catch (error) {
      accepted = false;
      detail = String(error).slice(0, 160);
    }
    report.ok(`${mode} 对称可设置并落笔`, accepted && session.contentHash() !== base, detail);
    session.free();
  }
}

// ---- 非法模式被拒绝 ----------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  let rejected = false;
  try {
    session.execute("paint.setSymmetry", JSON.stringify({ mode: "spiral" }));
  } catch {
    rejected = true;
  }
  report.ok("未知对称模式被拒绝", rejected);
  session.free();
}

// ---- 对称不改内容指纹 ------------------------------------------------
// 对称是会话状态：设置/关闭都不应推进内容指纹，否则「切工具就变脏」。
{
  const session = newSession(mod, { width: 48, height: 32 });
  const base = session.contentHash();
  session.execute("paint.setSymmetry", JSON.stringify({ mode: "vertical", center: [24, 16], rotation: 15 }));
  const afterSet = session.contentHash();
  session.execute("paint.symmetryDisable", "{}");
  report.ok("设置/关闭对称不改变内容指纹", afterSet === base && session.contentHash() === base);
  session.free();
}

// ---- 从路径定义对称 ----------------------------------------------------
// 上游语义：必须先有 work path，否则拒绝。这里同时钉住「无路径拒绝」与「有路径成功」。
{
  const session = newSession(mod, { width: 64, height: 48 });
  let rejectedWithoutPath = false;
  try {
    session.paintingCommand("paint.symmetryFromPath", JSON.stringify({ name: "work" }));
  } catch {
    rejectedWithoutPath = true;
  }
  report.ok("无工作路径时从路径定义对称被拒绝（正确拒绝）", rejectedWithoutPath);

  session.execute("path.set", JSON.stringify({
    name: "work",
    path: { subpaths: [{ closed: false, knots: [[32, 0], [32, 48]] }] },
  }));
  let acceptedWithPath = true;
  let detail;
  try {
    session.paintingCommand("paint.symmetryFromPath", JSON.stringify({ name: "work" }));
  } catch (error) {
    acceptedWithPath = false;
    detail = String(error).slice(0, 160);
  }
  const state = JSON.parse(session.symmetryStateJson());
  report.ok("有工作路径时从路径定义对称成功", acceptedWithPath && state.enabled !== false, { detail, mode: state.mode });
  session.execute("paint.symmetryDisable", "{}");
  session.free();
}

report.finish();
