/** 原生文字布局的文档坐标；输入位置使用 DOM 的 UTF-16 偏移。 */
export type TextPoint = [number, number];
export type TextGeometry = {
  caret: [TextPoint, TextPoint];
  selection: [TextPoint, TextPoint, TextPoint, TextPoint][];
  hit: number | null;
  next?: number;
  range?:[number,number];
  frame?: [TextPoint, TextPoint, TextPoint, TextPoint];
};
export type TextSelectionUnit="word"|"line"|"paragraph"|"all";
export type TextNavigation = "charPrev" | "charNext" | "linePrev" | "lineNext" | "lineStart" | "lineEnd" | "wordPrev" | "wordNext";
export type TextGeometryRequest = { start: number; end: number; hit?: TextPoint; move?: TextNavigation; unit?:TextSelectionUnit };

export function decodeTextGeometry(value: unknown): TextGeometry {
  const invalid = () => { throw new Error("文字输入几何无效，请取消后重试"); };
  if (!value || typeof value !== "object") return invalid();
  const data = value as Record<string, unknown>;
  const point = (value: unknown): value is TextPoint => Array.isArray(value) && value.length === 2
    && value.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!Array.isArray(data.caret) || data.caret.length !== 2 || !data.caret.every(point)
    || !Array.isArray(data.selection) || !data.selection.every((quad) => Array.isArray(quad) && quad.length === 4 && quad.every(point))
    || !(data.hit === null || (typeof data.hit === "number" && Number.isSafeInteger(data.hit) && data.hit >= 0))) return invalid();
  if (data.next !== undefined && !(typeof data.next === "number" && Number.isSafeInteger(data.next) && data.next >= 0)) return invalid();
  if(data.range!==undefined && !(Array.isArray(data.range) && data.range.length===2 && data.range.every(n=>Number.isSafeInteger(n) && n>=0) && data.range[0]<=data.range[1])) return invalid();
  if (data.frame !== undefined && !(Array.isArray(data.frame) && data.frame.length===4 && data.frame.every(point))) return invalid();
  return { caret: data.caret as TextGeometry["caret"], selection: data.selection as TextGeometry["selection"], hit: data.hit as number | null,
    ...(data.next === undefined ? {} : {next:data.next as number}),...(data.range===undefined?{}:{range:data.range as [number,number]}), ...(data.frame===undefined?{}:{frame:data.frame as TextGeometry["frame"]}) };
}

/** 命中原生布局给出的旋转文字框，边界包含在内；无布局时不猜测提交。 */
export function textFrameContains(frame:TextGeometry["frame"],point:TextPoint):boolean|null {
  if(!frame) return null;
  if(point[0]<Math.min(...frame.map(p=>p[0])) || point[0]>Math.max(...frame.map(p=>p[0])) || point[1]<Math.min(...frame.map(p=>p[1])) || point[1]>Math.max(...frame.map(p=>p[1]))) return false;
  let positive=false,negative=false;
  for(let i=0;i<4;i++) {const a=frame[i],b=frame[(i+1)%4];const cross=(b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]);positive ||= cross>1e-8;negative ||= cross< -1e-8;}
  return !(positive && negative);
}
