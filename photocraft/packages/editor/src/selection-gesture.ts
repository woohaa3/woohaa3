/** 选区手势的阶段与几何；没有 DOM、内核写入或取景状态。 */
import { normalizeMarquee, type DocumentPoint, type PixelRect, type SelectionMode } from "./photo-editor-tools.js";

export type SelectionKeys = { shift: boolean; alt: boolean; space: boolean };
export function selectionModeForKeys(mode: SelectionMode, keys: Pick<SelectionKeys, "shift" | "alt">): SelectionMode {
  return keys.shift ? keys.alt ? "intersect" : "add" : keys.alt ? "subtract" : mode;
}

export class SelectionGesture {
  readonly mode: SelectionMode;
  private start: DocumentPoint;
  private end: DocumentPoint;
  private last: DocumentPoint;
  private points: DocumentPoint[];
  private reservedShift: boolean;
  private reservedAlt: boolean;
  private keys: SelectionKeys;

  constructor(readonly kind: "marquee" | "lasso", point: DocumentPoint,
    private readonly bounds: { width: number; height: number }, mode: SelectionMode, keys: SelectionKeys) {
    this.start = { ...point }; this.end = { ...point }; this.last = { ...point }; this.points = [{ ...point }];
    this.mode = selectionModeForKeys(mode, keys);
    this.reservedShift = keys.shift; this.reservedAlt = keys.alt; this.keys = { ...keys };
  }

  update(point: DocumentPoint, keys: SelectionKeys): void {
    if (!keys.shift) this.reservedShift = false;
    if (!keys.alt) this.reservedAlt = false;
    const dx = point.x-this.last.x, dy = point.y-this.last.y;
    if (keys.space) {
      const box = this.kind === "marquee" ? this.rect() : this.pathBounds();
      const tx = Math.max(-box.x,Math.min(this.bounds.width-box.x-box.width,dx));
      const ty = Math.max(-box.y,Math.min(this.bounds.height-box.y-box.height,dy));
      const move = (p: DocumentPoint) => ({x:p.x+tx,y:p.y+ty});
      this.start = move(this.start); this.end = move(this.end); this.points = this.points.map(move);
    } else {
      this.end = {x:this.end.x+dx,y:this.end.y+dy};
      if (this.kind === "lasso" && (dx !== 0 || dy !== 0)) this.points.push({ ...this.end });
    }
    this.last = { ...point }; this.keys = { ...keys };
  }

  key(key: string, pressed: boolean): boolean {
    const name = key === "Shift" ? "shift" : key === "Alt" ? "alt" : key === " " ? "space" : null;
    if (!name) return false;
    this.update(this.last,{...this.keys,[name]:pressed});
    return true;
  }

  rect(): PixelRect {
    const centered = this.keys.alt && !this.reservedAlt;
    const square = this.keys.shift && !this.reservedShift;
    const dx = this.end.x-this.start.x, dy = this.end.y-this.start.y;
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    const roomX = centered ? Math.min(this.start.x,this.bounds.width-this.start.x) : sx < 0 ? this.start.x : this.bounds.width-this.start.x;
    const roomY = centered ? Math.min(this.start.y,this.bounds.height-this.start.y) : sy < 0 ? this.start.y : this.bounds.height-this.start.y;
    let width = Math.max(0,Math.min(Math.abs(dx),roomX)), height = Math.max(0,Math.min(Math.abs(dy),roomY));
    if (square) width = height = Math.max(0,Math.min(Math.max(Math.abs(dx),Math.abs(dy)),roomX,roomY));
    const rect = centered
      ? normalizeMarquee({x:this.start.x-width,y:this.start.y-height},{x:this.start.x+width,y:this.start.y+height})
      : normalizeMarquee(this.start,{x:this.start.x+sx*width,y:this.start.y+sy*height});
    // 取整后仍在文档内，避免半像素起点使右/下边界多出一像素。
    rect.width = Math.min(rect.width,this.bounds.width-rect.x);
    rect.height = Math.min(rect.height,this.bounds.height-rect.y);
    if (square) rect.width = rect.height = Math.min(rect.width,rect.height);
    return rect;
  }

  path(): DocumentPoint[] { return [...this.points]; }
  private pathBounds(): PixelRect {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of this.points) {
      x = Math.min(x,point.x); y = Math.min(y,point.y);
      right = Math.max(right,point.x); bottom = Math.max(bottom,point.y);
    }
    return {x,y,width:right-x,height:bottom-y};
  }
}
