import type {DocumentPoint} from "./photo-editor-tools.js";
/** Shift 从按下位置开始锁定八方向；释放后恢复原始采样，压力不参与几何。 */
export class StrokeConstraint {
  private last:DocumentPoint;
  private anchor:DocumentPoint|null;
  private axis:{x:number;y:number}|null=null;
  constructor(point:DocumentPoint,shift:boolean,private readonly zoom:number) {
    this.last=point;this.anchor=shift?point:null;
  }
  update(point:DocumentPoint,shift:boolean):DocumentPoint {
    if(!shift) {this.anchor=null;this.axis=null;this.last=point;return point;}
    if(!this.anchor) this.anchor=this.last;
    const dx=point.x-this.anchor.x,dy=point.y-this.anchor.y;
    if(!this.axis && Math.hypot(dx,dy)*this.zoom>=3) {
      const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*Math.PI/4;
      this.axis={x:Math.cos(angle),y:Math.sin(angle)};
    }
    const distance=this.axis?dx*this.axis.x+dy*this.axis.y:0;
    const result={...point,x:this.anchor.x+(this.axis?.x??0)*distance,y:this.anchor.y+(this.axis?.y??0)*distance};
    this.last=result;return result;
  }
}
