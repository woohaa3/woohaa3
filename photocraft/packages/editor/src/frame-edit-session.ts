/** 连续属性草稿共用的帧调度和确认边界，不保存正式文档。 */
import type {EditorResult} from "./editor-wasm.js";
export type FrameEditPort<P>={begin:(layer:number)=>EditorResult<unknown>;preview:(params:P)=>EditorResult<unknown>;commit:()=>EditorResult<unknown>;cancel:()=>unknown};
export class FrameEditSession<P> {
  private frame:number|null=null;
  private pending:P|null=null;
  private generation=0;
  active=false;
  constructor(private readonly port:FrameEditPort<P>,private readonly refresh:()=>void,
    private readonly error:(message:string)=>void,private readonly onInfo:(info:unknown)=>void,
    private readonly merge:(previous:P|null,next:P)=>P) {}
  begin(layer:number):boolean {
    if (this.active) return false;
    const result=this.port.begin(layer);
    if (!result.ok) {this.error(result.message);return false;}
    this.generation++;this.active=true;this.onInfo(result.value);return true;
  }
  preview(params:P):void {
    if (!this.active) return;
    this.pending=this.merge(this.pending,params);
    if (this.frame!==null) return;
    const generation=this.generation;
    this.frame=requestAnimationFrame(()=>{
      if (!this.active || generation!==this.generation) return;
      this.frame=null;this.flush();
    });
  }
  private stopFrame():void {
    if (this.frame!==null) cancelAnimationFrame(this.frame);
    this.frame=null;this.generation++;
  }
  private flush():boolean {
    this.stopFrame();
    if (this.pending===null) return true;
    const result=this.port.preview(this.pending);
    if (!result.ok) {this.error(result.message);return false;}
    this.pending=null;this.onInfo(result.value);this.refresh();return true;
  }
  commit():boolean {
    if (!this.active || !this.flush()) return false;
    const result=this.port.commit();
    if (!result.ok) {this.error(result.message);return false;}
    this.active=false;this.generation++;this.refresh();return true;
  }
  /** 库管理前发布最新属性预览，保留已选资源快照；不确认正式文档。 */
  flushPreview():boolean {return this.active && this.flush();}
  cancel():void {
    this.stopFrame();this.pending=null;
    if (!this.active) return;
    this.active=false;this.port.cancel();this.refresh();
  }
}
