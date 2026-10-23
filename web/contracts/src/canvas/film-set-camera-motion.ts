/**
 * 镜头运动 IR 的确定性脚本序列化
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 4.2 / design D5）。
 *
 * 离线坐标迁移必须把「世界单位」的镜头轨道改写成「场景单位」后仍能以受支持脚本表达：先把旧
 * 脚本编译成确定性 IR（`executeMotionScript`），变换 IR，再用本模块生成等价脚本，最后重新执行
 * 并比对 IR。只生成 `motion.camera.tween`，与作者 API 的相机轨道一一对应；无法等价表达的形状
 * （同属性区间重叠、非有限值）由调用方先拒绝，不在这里猜测。
 *
 * 纯函数、无副作用：不 import 任何运行时/驱动。
 */
import type { CameraTrack } from "./motion-ir.js";

/** 把镜头轨道 IR 序列化为可稳定重跑的脚本；空轨道返回空脚本。 */
export function serializeCameraMotionTracks(tracks: readonly CameraTrack[]): string {
  return [...tracks]
    .map((track) => [
      "motion.camera.tween({",
      `  id: ${JSON.stringify(track.id)},`,
      `  property: ${JSON.stringify(track.property)},`,
      `  startTime: ${numberLiteral(track.startTime)},`,
      `  endTime: ${numberLiteral(track.endTime)},`,
      `  from: ${numberLiteral(track.from)},`,
      `  to: ${numberLiteral(track.to)},`,
      `  easing: ${JSON.stringify(track.easing)}`,
      "});"
    ].join("\n"))
    .join("\n\n");
}

/**
 * 数值字面量：足够精度且不带指数记号的稳定写法。
 *
 * JS 的 `String(number)` 已提供最短往返表示；这里只保证 `-0` 归一为 `0`，避免同一 IR 生成两种脚本。
 */
function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Object.is(value, -0) ? "0" : String(value);
}
