/** 自由变换的几何计算；累计矩阵始终作用于进入时的源内容。 */
export type TransformFrame = [number, number, number, number];
export type LayerTransform = { dx: number; dy: number; scaleX: number; scaleY: number; rotate: number };
export const IDENTITY_TRANSFORM: LayerTransform = { dx: 0, dy: 0, scaleX: 100, scaleY: 100, rotate: 0 };
export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];
export function multiplyTransform(left: readonly number[], right: readonly number[]): number[] {
  const [a,b,c,d,e,f] = left, [g,h,i,j,k,l] = right;
  return [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f];
}
export function inverseTransformPoint(matrix: readonly number[], point: { x: number; y: number }): { x: number; y: number } {
  const [a,b,c,d,e,f] = matrix;
  const det = a*d-b*c;
  return { x: (d*(point.x-e)-c*(point.y-f))/det, y: (-b*(point.x-e)+a*(point.y-f))/det };
}
export function transformValues(frame: TransformFrame, matrix: readonly number[]): LayerTransform {
  const [a,b,c,d,e,f] = matrix;
  const cx = (frame[0]+frame[2])/2, cy = (frame[1]+frame[3])/2;
  return { dx: a*cx+c*cy+e-cx, dy: b*cx+d*cy+f-cy, scaleX: Math.hypot(a,b)*100,
    scaleY: Math.hypot(c,d)*100, rotate: Math.atan2(b,a)*180/Math.PI };
}
export type TransformHandle = "move" | "rotate" | "nw" | "ne" | "sw" | "se";

export function transformMatrix(frame: TransformFrame, value: LayerTransform): number[] | null {
  if (!Object.values(value).every(Number.isFinite) || value.scaleX < 1 || value.scaleY < 1 || value.scaleX > 1600 || value.scaleY > 1600) return null;
  const [x0, y0, x1, y1] = frame;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const angle = value.rotate * Math.PI / 180;
  const a = Math.cos(angle) * value.scaleX / 100, b = Math.sin(angle) * value.scaleX / 100;
  const c = -Math.sin(angle) * value.scaleY / 100, d = Math.cos(angle) * value.scaleY / 100;
  return [a, b, c, d, cx + value.dx - a * cx - c * cy, cy + value.dy - b * cx - d * cy];
}

export function dragLayerTransform(frame: TransformFrame, handle: TransformHandle, start: { x: number; y: number }, end: { x: number; y: number }, proportional: boolean): LayerTransform {
  return transformValues(frame, dragTransformMatrix(frame, IDENTITY_MATRIX, handle, start, end,
    { linked: proportional, shift: handle === "rotate" && proportional, centered: false, reference: frameCenter(frame) }));
}

export type TransformPoint = { x: number; y: number };
export const frameCenter = (frame: TransformFrame): TransformPoint => ({ x: (frame[0]+frame[2])/2, y: (frame[1]+frame[3])/2 });
export function projectTransformPoint(matrix: readonly number[], point: TransformPoint): TransformPoint {
  return { x: matrix[0]*point.x+matrix[2]*point.y+matrix[4], y: matrix[1]*point.x+matrix[3]*point.y+matrix[5] };
}
function around(point: TransformPoint, linear: number[]): number[] {
  const [a,b,c,d] = linear;
  return [a,b,c,d,point.x-a*point.x-c*point.y,point.y-b*point.x-d*point.y];
}

/** 数值只修改指定分量，保留累计矩阵中的反射、剪切及其他分量。 */
export function updateTransformValue(frame: TransformFrame, matrix: readonly number[], key: keyof LayerTransform, value: number, reference: TransformPoint, linked: boolean): number[] | null {
  if (!Number.isFinite(value)) return null;
  const current = transformValues(frame, matrix);
  if (key === "dx" || key === "dy") {
    const next = [...matrix]; next[key === "dx" ? 4 : 5] += value-current[key]; return next;
  }
  if (key === "rotate") {
    const angle = (value-current.rotate)*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
    return multiplyTransform(around(projectTransformPoint(matrix, reference), [c,s,-s,c]), matrix);
  }
  const ratio = value/current[key];
  const sx = key === "scaleX" || linked ? ratio : 1, sy = key === "scaleY" || linked ? ratio : 1;
  if (current.scaleX*sx < 1 || current.scaleX*sx > 1600 || current.scaleY*sy < 1 || current.scaleY*sy > 1600) return null;
  return multiplyTransform(matrix, around(reference, [sx,0,0,sy]));
}

export type TransformDragHandle = TransformHandle | "n" | "e" | "s" | "w";
/** 输入点为文档坐标；缩放沿变换后的局部轴，旋转在文档平面进行。 */
export function dragTransformMatrix(frame: TransformFrame, matrix: readonly number[], handle: TransformDragHandle, start: TransformPoint, end: TransformPoint,
  { linked, shift, centered, reference }: { linked: boolean; shift: boolean; centered: boolean; reference: TransformPoint }): number[] {
  if (handle === "move") return multiplyTransform([1,0,0,1,end.x-start.x,end.y-start.y], matrix);
  if (handle === "rotate") {
    const pivot = projectTransformPoint(matrix, reference);
    let angle = Math.atan2(end.y-pivot.y,end.x-pivot.x)-Math.atan2(start.y-pivot.y,start.x-pivot.x);
    if (shift) angle = Math.round(angle/(Math.PI/12))*Math.PI/12;
    return multiplyTransform(around(pivot,[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle)]), matrix);
  }
  const from = inverseTransformPoint(matrix,start), to = inverseTransformPoint(matrix,end);
  const horizontal = handle.includes("e") || handle.includes("w"), vertical = handle.includes("n") || handle.includes("s");
  const center = frameCenter(frame);
  const anchor = centered ? reference : { x: horizontal ? (handle.includes("e") ? frame[0] : frame[2]) : center.x,
    y: vertical ? (handle.includes("s") ? frame[1] : frame[3]) : center.y };
  const hx = handle.includes("e") ? frame[2] : frame[0], hy = handle.includes("s") ? frame[3] : frame[1];
  const ratio = (delta: number, distance: number) => Math.abs(distance) < 1e-9 ? 1 : 1+delta/distance;
  let sx = horizontal ? ratio(to.x-from.x,hx-anchor.x) : 1, sy = vertical ? ratio(to.y-from.y,hy-anchor.y) : 1;
  const proportional = linked !== shift;
  if (proportional) sx = sy = !horizontal ? sy : !vertical ? sx : Math.abs(sx-1) > Math.abs(sy-1) ? sx : sy;
  const current = transformValues(frame,matrix);
  if (proportional) sx = sy = Math.max(Math.max(1/current.scaleX,1/current.scaleY), Math.min(Math.min(1600/current.scaleX,1600/current.scaleY),sx));
  else { sx = Math.max(1/current.scaleX,Math.min(1600/current.scaleX,sx)); sy = Math.max(1/current.scaleY,Math.min(1600/current.scaleY,sy)); }
  return multiplyTransform(matrix,around(anchor,[sx,0,0,sy]));
}
