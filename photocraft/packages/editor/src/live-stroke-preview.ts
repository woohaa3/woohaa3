/** 按动画帧合并增量采样；临时像素仍由同一编辑内核合成。 */
import type { EditorWorkspaceController } from "./editor-workspace.js";
import type { EditorResult } from "./editor-wasm.js";
import { strokePoints, type DocumentPoint } from "./photo-editor-tools.js";

export class LiveStrokePreview {
  private active = false;
  private pencil = false;
  private initial:Record<string,unknown>|null=null;
  private pending: DocumentPoint[] = [];
  private frame: number | null = null;
  private generation=0;
  private last:DocumentPoint|null=null;
  private timed=false;

  constructor(
    private readonly controller: EditorWorkspaceController,
    private readonly refresh: () => void,
    private readonly message: (message: string | null) => void,
    private readonly refreshStroke:()=>void=refresh
  ) {}

  begin(params: Record<string, unknown>): boolean {
    this.cancel();
    if (!this.check(this.controller.beginStroke(params))) return false;
    this.initial=structuredClone(params);
    this.pencil = params.strokeCommand === "paint.pencil";
    this.active = true;
    this.timed=false;
    const points=params.points as number[][],tail=points.at(-1);
    this.last=tail?{x:tail[0],y:tail[1],pressure:tail[2],tiltX:tail[3],tiltY:tail[4],rotation:tail[5],time:tail[6]}:null;
    this.schedule();
    return true;
  }

  append(points: DocumentPoint[]): void {
    if (!this.active) return;
    this.pending.push(...points);
    this.last=points.at(-1)??this.last;
    this.schedule();
  }

  replaceTap(point:DocumentPoint):boolean {
    if(!this.active || !this.initial || !Array.isArray(this.initial.points) || this.initial.points.length!==1)return false;
    if(this.timed){this.append([{...point,time:Math.max(point.time??0,this.last?.time??0)}]);return true;}
    this.last=point;
    this.stopFrame();this.pending=[];this.controller.cancelStroke();
    const result=this.controller.beginStroke({...this.initial,points:strokePoints([point],this.pencil)});
    if(!this.check(result))return false;
    this.schedule();return true;
  }
  finish(): boolean {
    if (!this.active) return false;
    this.stopFrame();
    if (!this.flush()) return false;
    this.active = false;
    const success = this.check(this.controller.commitStroke());
    if (success) this.message(null);
    return success;
    // 提交失败也恢复正式文档；成功后的常规修订 effect 负责刷新。
  }

  cancel(): void {
    this.stopFrame();
    this.pending = [];
    if (!this.active) return;
    this.active = false;
    this.controller.cancelStroke();
    this.refresh();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    const generation=this.generation;
    this.frame = requestAnimationFrame(time => {
      if(generation!==this.generation)return;
      this.frame = null;
      if(!this.active || !this.flush())return;
      if(this.last && this.controller.strokeWantsTime?.()){
        const held={...this.last,time:Math.max(time,this.last.time??0)};
        if(held.time>(this.last.time??0)){this.timed=true;this.last=held;this.pending.push(held);if(!this.flush())return;}
        this.schedule();
      }
      this.refreshStroke();
    });
  }

  private flush(): boolean {
    const points = this.pending;
    this.pending = [];
    return points.length === 0 || this.check(this.controller.appendStroke(strokePoints(points,this.pencil)));
  }

  private check(result: EditorResult<unknown>): boolean {
    if (result.ok) return true;
    const wasActive = this.active;
    this.cancel();
    if (!wasActive) this.refresh();
    this.message(result.message);
    return false;
  }

  private stopFrame(): void {
    this.generation++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
