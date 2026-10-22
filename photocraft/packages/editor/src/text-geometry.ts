/** 原生文字布局的文档坐标；输入位置使用 DOM 的 UTF-16 偏移。 */
export type TextPoint = [number, number];
export type TextGeometry = {
  caret: [TextPoint, TextPoint];
  selection: [TextPoint, TextPoint, TextPoint, TextPoint][];
  hit: number | null;
  next?: number;
  frame?: [TextPoint, TextPoint, TextPoint, TextPoint];
};
export type TextNavigation = "linePrev" | "lineNext" | "lineStart" | "lineEnd" | "wordPrev" | "wordNext";
export type TextGeometryRequest = { start: number; end: number; hit?: TextPoint; move?: TextNavigation };

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
  if (data.frame !== undefined && !(Array.isArray(data.frame) && data.frame.length===4 && data.frame.every(point))) return invalid();
  return { caret: data.caret as TextGeometry["caret"], selection: data.selection as TextGeometry["selection"], hit: data.hit as number | null,
    ...(data.next === undefined ? {} : {next:data.next as number}), ...(data.frame===undefined?{}:{frame:data.frame as TextGeometry["frame"]}) };
}
