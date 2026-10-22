import type { Projector, Vec3 } from "@woohaa3/contracts";

/** 按观察相机下的屏幕切线决定方位增量的符号，避免绕到模型背面后左右反向。 */
export function shotDragDirection(focus: Vec3, position: Vec3, project: Projector): number {
  const dx = position[0] - focus[0];
  const dz = position[2] - focus[2];
  const angle = 0.001;
  const next: Vec3 = [
    focus[0] + dx * Math.cos(angle) + dz * Math.sin(angle),
    position[1],
    focus[2] - dx * Math.sin(angle) + dz * Math.cos(angle)
  ];
  const from = project(position);
  const to = project(next);
  return from && to && to.x < from.x ? -1 : 1;
}
