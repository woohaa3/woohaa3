/** 选区手势的阶段与几何；没有 DOM、内核写入或取景状态。 */
import { normalizeMarquee, type DocumentPoint, type PixelRect, type SelectionMode } from "./photo-editor-tools.js";

export type MarqueeConstraint={mode:"normal"|"ratio"|"size";width:number;height:number};
export type SelectionKeys = { shift: boolean; alt: boolean; space: boolean };
export function selectionModeForKeys(mode: SelectionMode, keys: Pick<SelectionKeys, "shift" | "alt">, hasSelection=true): SelectionMode {
  if(!hasSelection && mode==="replace" && keys.alt && !keys.shift) return "replace";
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
  private offset={x:0,y:0};

  constructor(readonly kind: "marquee" | "lasso", point: DocumentPoint,
    private readonly bounds: { width: number; height: number }, mode: SelectionMode, keys: SelectionKeys, readonly line?:"row"|"column", hasSelection=true, readonly constraint?:MarqueeConstraint) {
    this.start = { ...point }; this.end = { ...point }; this.last = { ...point }; this.points = [{ ...point }];
    this.mode = selectionModeForKeys(mode, keys,hasSelection);
    this.reservedShift = keys.shift; this.reservedAlt = keys.alt && (hasSelection || mode!=="replace" || keys.shift); this.keys = { ...keys };
  }

  update(point: DocumentPoint, keys: SelectionKeys): void {
    if (!keys.shift) this.reservedShift = false;
    if (!keys.alt) this.reservedAlt = false;
    const dx = point.x-this.last.x, dy = point.y-this.last.y;
    if (keys.space) {
      const move = (p: DocumentPoint) => ({x:p.x+dx,y:p.y+dy});
      this.offset={x:this.offset.x+dx,y:this.offset.y+dy};
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
    if(this.line==="row") return {x:0,y:Math.max(0,Math.min(this.bounds.height-1,Math.floor(this.end.y))),width:this.bounds.width,height:1};
    if(this.line==="column") return {x:Math.max(0,Math.min(this.bounds.width-1,Math.floor(this.end.x))),y:0,width:1,height:this.bounds.height};
    const centered = this.keys.alt && !this.reservedAlt;
    const preset=this.constraint;
    const fixed=preset?.mode==="size";
    const ratio=preset?.mode==="ratio"?preset.width/preset.height:undefined;
    const square = !fixed && ratio===undefined && this.keys.shift && !this.reservedShift;
    const dx = this.end.x-this.start.x, dy = this.end.y-this.start.y;
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    const roomX = centered ? Math.min(this.start.x-this.offset.x,this.bounds.width+this.offset.x-this.start.x) : sx < 0 ? this.start.x-this.offset.x : this.bounds.width+this.offset.x-this.start.x;
    const roomY = centered ? Math.min(this.start.y-this.offset.y,this.bounds.height+this.offset.y-this.start.y) : sy < 0 ? this.start.y-this.offset.y : this.bounds.height+this.offset.y-this.start.y;
    let width = Math.max(0,Math.min(Math.abs(dx),roomX)), height = Math.max(0,Math.min(Math.abs(dy),roomY));
    if(fixed && preset) {
      width=preset.width/(centered?2:1);height=preset.height/(centered?2:1);
    } else if(ratio && Number.isFinite(ratio) && ratio>0) {
      width=Math.max(Math.abs(dx),Math.abs(dy)*ratio);height=width/ratio;
      const scale=Math.min(1,Math.max(0,roomX)/width,Math.max(0,roomY)/height);
      if(width>0 && height>0) {width*=scale;height*=scale;}
    }
    if (square) width = height = Math.max(0,Math.min(Math.max(Math.abs(dx),Math.abs(dy)),roomX,roomY));
    const rect = centered
      ? normalizeMarquee({x:this.start.x-width,y:this.start.y-height},{x:this.start.x+width,y:this.start.y+height})
      : normalizeMarquee(this.start,{x:this.start.x+sx*width,y:this.start.y+sy*height});
    // 取整后仍在文档内，避免半像素起点使右/下边界多出一像素。
    if(fixed) return rect;
    rect.width = Math.min(rect.width,this.bounds.width+this.offset.x-rect.x);
    rect.height = Math.min(rect.height,this.bounds.height+this.offset.y-rect.y);
    if (square) rect.width = rect.height = Math.min(rect.width,rect.height);
    return rect;
  }

  path(): DocumentPoint[] { return [...this.points]; }
}
