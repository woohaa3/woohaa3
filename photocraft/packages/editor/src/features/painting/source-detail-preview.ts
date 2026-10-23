/** 源像素细节的纯调度：不持有文档、不注册输入，也不创建绘制表面。 */
import type {EditorPreview,EditorPreviewRegion,EditorResult} from "../../editor-wasm.js";

export const DETAIL_TILE_SIDE=512;
export const DETAIL_MAX_TILES=64;
export type DetailViewport={width:number;height:number;x:number;y:number;zoom:number};
export type DetailTile=EditorPreviewRegion & {key:string};
export type DetailPlan={width:number;height:number;tiles:readonly DetailTile[]};
export type DetailFrame=Omit<DetailPlan,"tiles"> & {tiles:readonly (DetailTile & {preview:EditorPreview})[];onUploadFailure?:()=>void};
export type DetailRequest={
  width:number;height:number;view:DetailViewport;contentVersion:unknown;
  /** 调用方能确定改动范围时仅失效相交块；缺省或非法范围一律清空。 */
  changedRegions?:readonly EditorPreviewRegion[];
  keepPrevious?:boolean;
  immediate?:boolean;
};

/** 100% 及以上读取源像素；小图和缩小视图继续使用基础预览。 */
export function planSourceDetails(width:number,height:number,view:DetailViewport):DetailPlan {
  const empty={width,height,tiles:[]};
  if (![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647) ||
      ![view.width,view.height,view.x,view.y,view.zoom].every(Number.isFinite) ||
      view.width<=0 || view.height<=0 || view.zoom<1 || Math.max(width,height)<=2048) return empty;
  const centerX=width/2-view.x/view.zoom,centerY=height/2-view.y/view.zoom;
  const x0=Math.max(0,Math.floor(centerX-view.width/(2*view.zoom)));
  const y0=Math.max(0,Math.floor(centerY-view.height/(2*view.zoom)));
  const x1=Math.min(width,Math.ceil(centerX+view.width/(2*view.zoom)));
  const y1=Math.min(height,Math.ceil(centerY+view.height/(2*view.zoom)));
  if (x1<=x0 || y1<=y0) return empty;
  const firstX=Math.floor(x0/DETAIL_TILE_SIDE),firstY=Math.floor(y0/DETAIL_TILE_SIDE);
  const lastX=Math.ceil(x1/DETAIL_TILE_SIDE),lastY=Math.ceil(y1/DETAIL_TILE_SIDE);
  if ((lastX-firstX)*(lastY-firstY)>DETAIL_MAX_TILES) throw new Error("当前视口超出源像素细节缓存上限");
  const tiles:DetailTile[]=[];
  for(let row=firstY;row<lastY;row++) for(let col=firstX;col<lastX;col++) {
    const x=col*DETAIL_TILE_SIDE,y=row*DETAIL_TILE_SIDE;
    tiles.push({key:`${col}:${row}`,x,y,width:Math.min(DETAIL_TILE_SIDE,width-x),height:Math.min(DETAIL_TILE_SIDE,height-y)});
  }
  tiles.sort((a,b)=>Math.hypot(a.x+a.width/2-centerX,a.y+a.height/2-centerY)-Math.hypot(b.x+b.width/2-centerX,b.y+b.height/2-centerY));
  return {width,height,tiles};
}

export type DetailFrameScheduler={request:(callback:()=>void)=>number;cancel:(id:number)=>void};
const browserFrames:DetailFrameScheduler={request:cb=>requestAnimationFrame(cb),cancel:id=>cancelAnimationFrame(id)};

/** 每帧最多读取两块，缓存最多 64 MiB；只发布同一内容版本的完整可见集合。 */
export class SourceDetailPreview {
  private readonly cache=new Map<string,{tile:DetailTile;preview:EditorPreview}>();
  private pending:number|null=null;
  private generation=0;
  private version:unknown;
  private size="";
  private disposed=false;
  private lastFrame:DetailFrame|null=null;
  constructor(
    private readonly read:(region:EditorPreviewRegion)=>EditorResult<EditorPreview>,
    private readonly publish:(frame:DetailFrame|null)=>void,
    private readonly fail:(message:string)=>void,
    private readonly frames:DetailFrameScheduler=browserFrames
  ) {}

  update(request:DetailRequest):void {
    if(this.disposed) return;
    this.cancelPending();
    const generation=this.generation;
    const size=`${request.width}:${request.height}`;
    const changed=!Object.is(this.version,request.contentVersion);
    if(this.size!==size) this.cache.clear();
    else if(changed) {
      const regions=request.changedRegions;
      const valid=Array.isArray(regions) && regions.every(r=>[r.x,r.y,r.width,r.height].every(Number.isSafeInteger) && r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=request.width && r.y+r.height<=request.height);
      if(!valid) this.cache.clear();
      else for(const [key,{tile}] of this.cache) {
        if(regions.some(r=>r.x<tile.x+tile.width && r.x+r.width>tile.x && r.y<tile.y+tile.height && r.y+r.height>tile.y)) this.cache.delete(key);
      }
    }
    this.version=request.contentVersion;this.size=size;
    // 新取景/内容立即撤回旧细节；基础预览由原 owner 保留。
    if(!request.keepPrevious)this.emit(null);
    if(this.disposed || generation!==this.generation) return;
    let plan:DetailPlan;
    try {plan=planSourceDetails(request.width,request.height,request.view);}
    catch(error) {this.fail(error instanceof Error?error.message:"无法规划源像素细节");return;}
    if(!plan.tiles.length) {if(request.keepPrevious)this.emit(null);return;}
    const visible=new Set(plan.tiles.map(tile=>tile.key));
    // 先逐出不在新视口内的最旧条目，保证新集合始终有容量。
    for(const key of this.cache.keys()) if(!visible.has(key)) this.cache.delete(key);
    let next=0;
    const step=()=>{
      this.pending=null;
      if(this.disposed || generation!==this.generation) return;
      let reads=0;
      while(next<plan.tiles.length) {
        const tile=plan.tiles[next];
        if(!this.cache.has(tile.key)) {
          if(reads===2) break;
          reads++;
          let result:EditorResult<EditorPreview>;
          try {result=this.read({x:tile.x,y:tile.y,width:tile.width,height:tile.height});}
          catch(error) {result={ok:false,code:"render-failed",message:error instanceof Error?error.message:"源像素细节读取失败"};}
          if(this.disposed || generation!==this.generation) return;
          if(!result.ok) {this.fail(result.message);return;}
          const preview=result.value;
          if(preview.width!==tile.width || preview.height!==tile.height || !(preview.pixels instanceof Uint8Array) || preview.pixels.length!==tile.width*tile.height*4) {
            this.fail("源像素细节数据不完整");return;
          }
          this.cache.set(tile.key,{tile,preview});
        }
        next++;
      }
      if(next<plan.tiles.length) {this.pending=this.frames.request(step);return;}
      this.emit({...plan,tiles:plan.tiles.map(tile=>({...tile,preview:this.cache.get(tile.key)!.preview}))});
    };
    // 全部命中时同步恢复，不再等待一帧。
    if(request.immediate || plan.tiles.every(tile=>this.cache.has(tile.key))) step();
    else this.pending=this.frames.request(step);
  }

  clear():void {
    this.cancelPending();this.cache.clear();this.size="";this.version=undefined;
    this.emit(null);
  }
  /** 同步停止旧读取，保留上次完整画面与可复用块，供局部草稿更新。 */
  pause():void {this.cancelPending();}
  hasCoverage(width:number,height:number,view:DetailViewport):boolean {
    const last=this.lastFrame;
    if(!last || last.width!==width || last.height!==height)return false;
    try {
      const plan=planSourceDetails(width,height,view);
      return plan.tiles.length>0 && plan.tiles.every(tile=>last.tiles.some(old=>old.key===tile.key));
    } catch {return false;}
  }
  private emit(frame:DetailFrame|null):void {this.lastFrame=frame;this.publish(frame);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.clear();}
  private cancelPending():void {
    this.generation++;
    if(this.pending!==null) this.frames.cancel(this.pending);
    this.pending=null;
  }
}
