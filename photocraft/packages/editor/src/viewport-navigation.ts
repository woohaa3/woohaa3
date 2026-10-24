import type {EditorViewport} from "./viewport.js";
export type ViewportNavigation={key:"PageUp"|"PageDown"|"Home"|"End";horizontal:boolean;small:boolean};
/** Page navigation clamps to the document extent; smaller images remain centered. */
export function navigateViewport(view:EditorViewport,size:{width:number;height:number},document:{width:number;height:number},navigation:ViewportNavigation):EditorViewport {
 const limitX=Math.max(0,(document.width*view.zoom-size.width)/2),limitY=Math.max(0,(document.height*view.zoom-size.height)/2);
 if(navigation.key==="Home" || navigation.key==="End"){
  const direction=navigation.key==="Home"?1:-1;return {...view,x:direction*limitX,y:direction*limitY};
 }
 const axis=navigation.horizontal?"x":"y",limit=navigation.horizontal?limitX:limitY,amount=navigation.small?10:navigation.horizontal?size.width:size.height;
 return {...view,[axis]:Math.max(-limit,Math.min(limit,view[axis]+(navigation.key==="PageUp"?amount:-amount)))};
}
