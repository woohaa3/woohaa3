import { expect, it } from "vitest";
import { dragLayerTransform, IDENTITY_TRANSFORM, transformMatrix, type TransformFrame } from "./transform-layer.js";

const frame: TransformFrame = [20, 30, 120, 80];
const project = (matrix: number[], point: [number, number]) => [matrix[0]! * point[0] + matrix[2]! * point[1] + matrix[4]!, matrix[1]! * point[0] + matrix[3]! * point[1] + matrix[5]!];
it("缩放角点保持对角固定，Shift 等比缩放", () => {
  const value = dragLayerTransform(frame, "se", { x: 120, y: 80 }, { x: 170, y: 80 }, true);
  const matrix = transformMatrix(frame, value)!;
  expect(value.scaleX).toBe(150); expect(value.scaleY).toBe(150);
  expect(project(matrix, [20, 30])).toEqual([20, 30]);
  expect(project(matrix, [120, 80])).toEqual([170, 105]);
});
it("旋转围绕图层中心且按 15° 吸附；非法缩放不生成矩阵", () => {
  const value = dragLayerTransform(frame, "rotate", { x: 70, y: 0 }, { x: 120, y: 55 }, true);
  expect(value.rotate).toBe(90);
  const center = project(transformMatrix(frame, value)!, [70, 55]);
  expect(center[0]).toBeCloseTo(70); expect(center[1]).toBeCloseTo(55);
  expect(transformMatrix(frame, { ...IDENTITY_TRANSFORM, scaleX: NaN })).toBeNull();
  expect(transformMatrix(frame, { ...IDENTITY_TRANSFORM, scaleY: 0 })).toBeNull();
});

it("多次拖动累计矩阵，旋转后移动保持文档坐标，逆映射可恢复指针位置", async () => {
  const { inverseTransformPoint, multiplyTransform, transformValues } = await import("./transform-layer.js");
  const rotation = transformMatrix(frame, { ...IDENTITY_TRANSFORM, rotate: 90 })!;
  const moved = multiplyTransform([1,0,0,1,20,10], rotation);
  const center = project(moved, [70,55]);
  expect(center[0]).toBeCloseTo(90); expect(center[1]).toBeCloseTo(65);
  const restored = inverseTransformPoint(moved, { x: center[0], y: center[1] });
  expect(restored.x).toBeCloseTo(70); expect(restored.y).toBeCloseTo(55);
  expect(transformValues(frame, moved)).toMatchObject({ dx: 20, dy: 10, scaleX: 100, scaleY: 100, rotate: 90 });
});

it("四个边中点固定对边，链接比例与 Shift 切换可用", async () => {
  const { dragTransformMatrix, IDENTITY_MATRIX, frameCenter } = await import("./transform-layer.js");
  const cases = [
    ["e", [120,55], [170,55], [20,55], 150,100],
    ["w", [20,55], [-30,55], [120,55], 150,100],
    ["n", [70,30], [70,5], [70,80], 100,150],
    ["s", [70,80], [70,105], [70,30], 100,150],
  ] as const;
  for (const [handle,start,end,anchor,sx,sy] of cases) {
    const options = { linked: true, shift: true, centered: false, reference: frameCenter(frame) };
    const matrix = dragTransformMatrix(frame,IDENTITY_MATRIX,handle,{x:start[0],y:start[1]},{x:end[0],y:end[1]},options);
    expect(project(matrix,[...anchor])).toEqual(anchor);
    expect(matrix[0]*100).toBe(sx); expect(matrix[3]*100).toBe(sy);
    const linked = dragTransformMatrix(frame,IDENTITY_MATRIX,handle,{x:start[0],y:start[1]},{x:end[0],y:end[1]},{...options,shift:false});
    expect(linked[0]).toBe(1.5); expect(linked[3]).toBe(1.5);
  }
});
it("Alt 缩放和数值链接使用同一自定参考点，旋转后仍沿局部轴", async () => {
  const { dragTransformMatrix, updateTransformValue } = await import("./transform-layer.js");
  const initial = transformMatrix(frame,{...IDENTITY_TRANSFORM,rotate:90,scaleX:200})!;
  const reference = {x:40,y:40};
  const start = project(initial,[120,80]), end = project(initial,[160,100]);
  const matrix = dragTransformMatrix(frame,initial,"se",{x:start[0],y:start[1]},{x:end[0],y:end[1]},
    {linked:true,shift:false,centered:true,reference});
  const numeric = updateTransformValue(frame,initial,"scaleX",300,reference,true)!;
  matrix.forEach((v,i) => expect(v).toBeCloseTo(numeric[i]));
  const before = project(initial,[40,40]), after = project(matrix,[40,40]);
  after.forEach((v,i) => expect(v).toBeCloseTo(before[i]));
});
it("数值位移保留剪切与反射；旋转围参考点且不改变两轴长度", async () => {
  const { updateTransformValue, transformValues } = await import("./transform-layer.js");
  const initial = [-2,0,0.4,1.2,10,20], reference = {x:40,y:40};
  const moved = updateTransformValue(frame,initial,"dx",35,reference,false)!;
  expect(moved.slice(0,4)).toEqual(initial.slice(0,4));
  expect(transformValues(frame,moved).dx).toBeCloseTo(35);
  const rotated = updateTransformValue(frame,initial,"rotate",90,reference,false)!;
  const before = project(initial,[40,40]), after = project(rotated,[40,40]);
  after.forEach((v,i) => expect(v).toBeCloseTo(before[i]));
  expect(transformValues(frame,rotated).scaleY).toBeCloseTo(transformValues(frame,initial).scaleY);
  expect(rotated[0]*rotated[3]-rotated[1]*rotated[2]).toBeCloseTo(-2.4);
  expect(updateTransformValue(frame,initial,"scaleX",NaN,reference,true)).toBeNull();
  expect(updateTransformValue(frame,initial,"scaleX",0,reference,true)).toBeNull();
  expect(updateTransformValue(frame,[1,0,0,16,0,0],"scaleX",200,reference,true)).toBeNull();
});
it("非等比缩放之后旋转在文档平面保持刚性，Shift 吸附 15°", async () => {
  const { dragTransformMatrix, frameCenter, transformValues } = await import("./transform-layer.js");
  const initial = transformMatrix(frame,{...IDENTITY_TRANSFORM,scaleX:200})!;
  const matrix = dragTransformMatrix(frame,initial,"rotate",{x:120,y:55},{x:70,y:105},
    {linked:true,shift:true,centered:false,reference:frameCenter(frame)});
  expect(transformValues(frame,matrix)).toMatchObject({scaleX:200,scaleY:100,rotate:90});
  const end = project(matrix,[120,55]); expect(end[0]).toBeCloseTo(70); expect(end[1]).toBeCloseTo(155);
});
