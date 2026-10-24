import type {EditorViewport} from "./viewport.js";
/** Port of upstream scrollbars::clamp_axis in the editor's centered screen-offset coordinates. */
export function clampViewport(view:EditorViewport,size:{width:number;height:number},document:{width:number;height:number},overscroll:boolean):EditorViewport {
 if(overscroll || ![view.zoom,size.width,size.height,document.width,document.height].every(value=>Number.isFinite(value)&&value>0))return view;
 const axis=(offset:number,length:number,span:number)=>{
  const limit=Math.abs(length*view.zoom-span)/2;
  return Number.isFinite(offset)?Math.max(-limit,Math.min(limit,offset)):0;
 };
 return {...view,x:axis(view.x,document.width,size.width),y:axis(view.y,document.height,size.height)};
}
