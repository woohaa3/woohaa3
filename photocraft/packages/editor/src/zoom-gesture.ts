import {clampEditorZoom,stepEditorZoom} from "./zoom-levels.js";
import {zoomAt} from "./viewport-motion.js";
import type {EditorViewport} from "./viewport.js";
type Point={x:number;y:number};
export type ZoomRectangle={x:number;y:number;width:number;height:number};
export type ZoomGestureContext={view:EditorViewport;width:number;height:number;documentWidth:number;documentHeight:number;scrubby:boolean;center:boolean;publish:(next:EditorViewport)=>void;animate?:(next:EditorViewport)=>void};
/** Navigation candidates only; never dispatch document commands. */
export class ZoomToolGesture {
 private gesture:{context:ZoomGestureContext;anchor:Point;out:boolean;moved:boolean;held:boolean;started:number;last:number}|null=null;
 private frame:number|null=null;private generation=0;
 constructor(private readonly read:()=>ZoomGestureContext,private readonly rectangle:(next:ZoomRectangle|null)=>void){}
 start(anchor:Point,out:boolean):void{
  this.cancel();const context=this.read(),now=performance.now();this.gesture={context:{...context,view:{...context.view}},anchor,out,moved:false,held:false,started:now,last:now};
  const generation=this.generation;
  const tick=(time:number)=>{
   const current=this.gesture;if(!current || generation!==this.generation || current.moved)return;this.frame=null;
   if(time-current.started>=300){const elapsed=Math.max(0,Math.min(32,time-Math.max(current.last,current.started+300))),view=this.read().view;current.held=true;
    const zoom=clampEditorZoom(view.zoom*Math.pow(2,(current.out?-1:1)*elapsed/1000),context.documentWidth,context.documentHeight);
    context.publish(zoomAt(view,zoom,{x:anchor.x-context.width/2,y:anchor.y-context.height/2}));
   }current.last=time;this.frame=requestAnimationFrame(tick);
  };this.frame=requestAnimationFrame(tick);
 }
 private stopFrame(){this.generation++;if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;}
 move(point:Point):void{
  const current=this.gesture;if(!current)return;const {context,anchor}=current;
  if(!current.moved && Math.hypot(point.x-anchor.x,point.y-anchor.y)<3)return;
  current.moved=true;this.stopFrame();
  if(context.scrubby){const zoom=clampEditorZoom(context.view.zoom*Math.pow(2,Math.max(-40,Math.min(40,(point.x-anchor.x)/100))),context.documentWidth,context.documentHeight);
   context.publish(zoomAt(context.view,zoom,{x:anchor.x-context.width/2,y:anchor.y-context.height/2}));
  }else this.rectangle({x:Math.min(anchor.x,point.x),y:Math.min(anchor.y,point.y),width:Math.abs(point.x-anchor.x),height:Math.abs(point.y-anchor.y)});
 }
 end(point:Point,out:boolean):void{
  this.move(point);const current=this.gesture;if(!current)return;const {context,anchor}=current;this.stopFrame();this.gesture=null;this.rectangle(null);
  const width=Math.abs(point.x-anchor.x),height=Math.abs(point.y-anchor.y);
  if(!current.moved && !current.held || current.moved && !context.scrubby && (out || width<4 || height<4)){
   const view=this.read().view,zoom=stepEditorZoom(view.zoom,out?-1:1,context.documentWidth,context.documentHeight);
   (context.animate??context.publish)(zoomAt(view,zoom,{x:anchor.x-context.width/2,y:anchor.y-context.height/2},context.center));
  }else if(current.moved && !context.scrubby){
   const zoom=clampEditorZoom(context.view.zoom*Math.min(context.width/width,context.height/height),context.documentWidth,context.documentHeight);
   (context.animate??context.publish)(zoomAt(context.view,zoom,{x:(anchor.x+point.x-context.width)/2,y:(anchor.y+point.y-context.height)/2},true));
  }
 }
 cancel():void{this.stopFrame();this.gesture=null;this.rectangle(null);}
 get active():boolean{return this.gesture!==null;}
}
