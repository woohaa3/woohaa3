import {clampEditorZoom,stepEditorZoom} from "./zoom-levels.js";
import {zoomAt} from "./viewport-motion.js";
import type {EditorViewport} from "./viewport.js";
export type WheelNavigationOptions={zoomWithScrollWheel:boolean;zoomWithTrackpadPinch:boolean};
export type WheelInput={deltaX:number;deltaY:number;deltaMode:number;ctrlKey:boolean;metaKey:boolean;altKey:boolean;shiftKey:boolean;timeStamp:number};
export type WheelContext=WheelNavigationOptions&{view:EditorViewport;width:number;height:number;documentWidth:number;documentHeight:number;anchor:{x:number;y:number}};
/** Raw wheel events own their modifiers; no delayed tail can turn a zoom into a pan. */
export class WheelNavigation {
 private lastPinch:number|null=null;private snap={amount:0,time:-Infinity,direction:0};
 reset(){this.lastPinch=null;this.snap={amount:0,time:-Infinity,direction:0};}
 apply(event:WheelInput,context:WheelContext):EditorViewport|null {
  if(![event.deltaX,event.deltaY,event.timeStamp].every(Number.isFinite)||(!event.deltaX&&!event.deltaY))return null;
  const unit=event.deltaMode===1?40:event.deltaMode===2?context.height:1;
  const dx=event.deltaX*unit,dy=event.deltaY*unit;
  // Browsers expose trackpad magnification as high-resolution Ctrl+wheel. Preserve whole
  // mouse notches (100/120 CSS px, or integer line units) as horizontal scrolling.
  const whole=(value:number)=>!value || (event.deltaMode===1?Number.isInteger(value):event.deltaMode===2?true:value%100===0||value%120===0);
  const recent=this.lastPinch!==null&&event.timeStamp>=this.lastPinch&&event.timeStamp-this.lastPinch<250;
  const pinch=event.ctrlKey&&!event.altKey&&!event.metaKey&&context.zoomWithTrackpadPinch&&(recent||!whole(event.deltaX)||!whole(event.deltaY));
  const around=(zoom:number)=>zoomAt(context.view,clampEditorZoom(zoom,context.documentWidth,context.documentHeight),context.anchor);
  if(pinch){this.lastPinch=event.timeStamp;this.snap.amount=0;return around(context.view.zoom*Math.exp(Math.max(-8,Math.min(8,-(dx+dy)*.01))));}
  this.lastPinch=null;
  const command=event.ctrlKey||event.metaKey;
  const zoom=!command && (context.zoomWithScrollWheel!==event.altKey);
  if(!zoom){this.snap.amount=0;return {...context.view,x:context.view.x-(command||event.shiftKey?dx+dy:dx),y:context.view.y-(command||event.shiftKey?0:dy)};}
  const amount=-(dx+dy)/120;
  if(event.shiftKey){
   const direction=Math.sign(amount);
   if(event.timeStamp-this.snap.time>500||event.timeStamp<this.snap.time||direction!==this.snap.direction)this.snap.amount=0;
   this.snap.amount+=amount;this.snap.time=event.timeStamp;this.snap.direction=direction;
   let steps=Math.trunc(this.snap.amount);this.snap.amount-=steps;if(!steps)return null;
   let zoom=context.view.zoom;steps=Math.max(-64,Math.min(64,steps));for(let index=0;index<Math.abs(steps);index++)zoom=stepEditorZoom(zoom,Math.sign(steps),context.documentWidth,context.documentHeight);
   return around(zoom);
  }
  this.snap.amount=0;
  return around(context.view.zoom*Math.pow(1.1,Math.max(-64,Math.min(64,amount))));
 }
}
