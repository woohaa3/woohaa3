import type {EditorViewport} from "./viewport.js";
type Point={x:number;y:number};
/** Screen-space navigation only: no document mutation or renderer dependency. */
export class FlickPan {
 private samples:{at:number;point:Point}[]=[];
 private velocity:Point|null=null;
 start(point:Point,at:number):void {this.stop();this.samples=[{point,at}];}
 track(point:Point,at:number):void {
  if(!Number.isFinite(at) || !Number.isFinite(point.x) || !Number.isFinite(point.y))return;
  this.samples.push({at,point});
  while(this.samples.length>1 && at-this.samples[0]!.at>80)this.samples.shift();
 }
 release(at:number,enabled:boolean):boolean {
  const first=this.samples[0],last=this.samples.at(-1);this.velocity=null;
  if(enabled && first && last && at-last.at<=80 && last.at>first.at){
   const elapsed=(last.at-first.at)/1000,x=(last.point.x-first.point.x)/elapsed,y=(last.point.y-first.point.y)/elapsed,speed=Math.hypot(x,y);
   if(Number.isFinite(speed) && speed>=150){const scale=Math.min(1,6000/speed);this.velocity={x:x*scale,y:y*scale};}
  }
  this.samples=[];return this.velocity!==null;
 }
 step(milliseconds:number):Point|null {
  const v=this.velocity;if(!v)return null;
  const dt=Number.isFinite(milliseconds)?Math.min(100,Math.max(0,milliseconds))/1000:0,decay=Math.exp(-dt/.18);
  this.velocity=Math.hypot(v.x*decay,v.y*decay)>=15?{x:v.x*decay,y:v.y*decay}:null;
  return {x:v.x*.18*(1-decay),y:v.y*.18*(1-decay)};
 }
 stop():void {this.samples=[];this.velocity=null;}
 get active():boolean {return this.velocity!==null;}
}
/** Keep the clicked document point under its screen anchor throughout the zoom. */
export function zoomAt(view:EditorViewport,zoom:number,anchor:Point,center=false):EditorViewport {
 const ratio=zoom/view.zoom;
 return {zoom,x:(center?0:anchor.x)-(anchor.x-view.x)*ratio,y:(center?0:anchor.y)-(anchor.y-view.y)*ratio};
}
export function interpolateViewport(from:EditorViewport,to:EditorViewport,elapsed:number,duration=220):EditorViewport {
 const t=Math.min(1,Math.max(0,elapsed/duration)),ease=t===1?1:1-Math.pow(1-t,3);
 return {x:from.x+(to.x-from.x)*ease,y:from.y+(to.y-from.y)*ease,zoom:from.zoom+(to.zoom-from.zoom)*ease};
}
