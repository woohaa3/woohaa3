import {clampEditorZoom} from "./zoom-levels.js";
import {zoomAt} from "./viewport-motion.js";
import type {EditorViewport} from "./viewport.js";
type Point={x:number;y:number};
type Context={view:EditorViewport;width:number;height:number;documentWidth:number;documentHeight:number};
/** Two contacts own navigation until both have lifted; a remaining finger never resumes a tool. */
export class TouchNavigation {
 private points=new Map<number,Point>();
 private gesture:{ids:[number,number];context:Context;center:Point;distance:number}|null=null;
 private draining=false;
 has(id:number){return this.points.has(id);}
 get contacts(){return this.points.size;}
 get active(){return this.gesture!==null||this.draining;}
 down(id:number,point:Point,context:Context):boolean {
  this.points.set(id,point);if(this.active)return true;
  if(this.points.size<2)return false;
  const ids=[...this.points.keys()].slice(0,2) as [number,number],a=this.points.get(ids[0])!,b=this.points.get(ids[1])!;
  this.gesture={ids,context:{...context,view:{...context.view}},center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};return true;
 }
 move(id:number,point:Point):EditorViewport|null {
  if(!this.points.has(id))return null;this.points.set(id,point);
  const gesture=this.gesture;if(!gesture)return null;
  const a=this.points.get(gesture.ids[0]),b=this.points.get(gesture.ids[1]);if(!a||!b)return null;
  const {context,center,distance}=gesture,zoom=clampEditorZoom(context.view.zoom*Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))/distance,context.documentWidth,context.documentHeight);
  const next=zoomAt(context.view,zoom,{x:center.x-context.width/2,y:center.y-context.height/2});
  return {...next,x:next.x+(a.x+b.x)/2-center.x,y:next.y+(a.y+b.y)/2-center.y};
 }
 up(id:number):boolean {
  const consumed=this.active;this.points.delete(id);
  if(this.gesture?.ids.includes(id)){this.gesture=null;this.draining=this.points.size>0;}
  if(!this.points.size)this.reset();return consumed;
 }
 reset():number[]{const ids=[...this.points.keys()];this.points.clear();this.gesture=null;this.draining=false;return ids;}
}
