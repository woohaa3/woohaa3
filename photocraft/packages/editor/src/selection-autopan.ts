/** 工具拖出可视区域才回写已有取景端口，不注册滚轮或触摸板输入。 */
export type SelectionPanContext = {
  pointer: {x:number;y:number}; width:number; height:number;
  documentWidth:number; documentHeight:number; zoom:number; x:number; y:number;
};
export function selectionPanStep(context: SelectionPanContext, seconds: number): {x:number;y:number} {
  const axis = (pointer:number,size:number,documentSize:number,offset:number) => {
    if (size <= 0 || !Number.isFinite(pointer)) return 0;
    const limit = Math.max(0,(documentSize*context.zoom-size)/2);
    if (!limit) return 0;
    const edge = Math.min(32,size/4);
    const speed = pointer < 0 ? Math.min(1,-pointer/edge)*480
      : pointer > size ? -Math.min(1,(pointer-size)/edge)*480 : 0;
    const delta = speed*Math.min(.032,Math.max(0,seconds));
    return delta > 0 ? Math.min(delta,Math.max(0,limit-offset)) : Math.max(delta,Math.min(0,-limit-offset));
  };
  return {x:axis(context.pointer.x,context.width,context.documentWidth,context.x),y:axis(context.pointer.y,context.height,context.documentHeight,context.y)};
}

export class SelectionAutoPan {
  private frame: number | null = null;
  private last: number | null = null;
  private generation = 0;
  constructor(private readonly read: () => SelectionPanContext | null, private readonly pan: (step: {x:number;y:number}) => void) {}
  update(): void {
    if (this.frame !== null) return;
    const context = this.read();
    if (!context) return;
    const step = selectionPanStep(context,1/60);
    if (!step.x && !step.y) return;
    const generation = this.generation;
    this.frame = requestAnimationFrame((time) => { if (generation === this.generation) this.tick(time); });
  }
  stop(): void {
    this.generation++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null; this.last = null;
  }
  private tick(time: number): void {
    this.frame = null;
    const context = this.read();
    if (!context) { this.last = null; return; }
    const step = selectionPanStep(context,this.last === null ? 1/60 : (time-this.last)/1000);
    this.last = time;
    if (!step.x && !step.y) { this.last = null; return; }
    this.pan(step);
    this.update();
  }
}
