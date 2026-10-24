export const MAX_GRID_PIXELS=1_048_576;
export const MAX_GRID_SEGMENTS=60_000;
export type PixelGridRegion={x:number;y:number;width:number;height:number};
export type PixelGridSegment=[number,number,number,number,number,number,number,number];
export function validatePixelGridRegion(region:PixelGridRegion):void {
  if(![region.x,region.y,region.width,region.height].every(Number.isSafeInteger)||region.width<0||region.height<0||region.width*region.height>MAX_GRID_PIXELS||Math.min(region.x,region.y)<-2147483648||Math.max(region.x+region.width,region.y+region.height)>2147483647)throw new Error("像素网格区域无效或超出预算");
}
export function decodePixelGrid(value:unknown,region:PixelGridRegion):PixelGridSegment[] {
  if(!Array.isArray(value)||value.length>MAX_GRID_SEGMENTS)throw new Error("像素网格读数无效");
  for(const line of value){
    if(!Array.isArray(line)||line.length!==8||!line.every(Number.isSafeInteger))throw new Error("像素网格读数无效");
    const [x0,y0,x1,y1,...color]=line;
    if(x0<region.x||x1<region.x||x0>region.x+region.width||x1>region.x+region.width||y0<region.y||y1<region.y||y0>region.y+region.height||y1>region.y+region.height||!(x0===x1&&y1>y0||y0===y1&&x1>x0)||color.some(c=>c<0||c>255))throw new Error("像素网格读数无效");
  }
  return value as PixelGridSegment[];
}
/** Bounds only the pixels actually covered by this view; no full-document scan. */
export function visiblePixelGridRegion(origin:{x:number;y:number},size:{width:number;height:number},zoom:number,document:{width:number;height:number}):PixelGridRegion|null {
  if(![origin.x,origin.y,size.width,size.height,zoom,document.width,document.height].every(Number.isFinite)||zoom<=0)return null;
  const x=Math.max(0,Math.floor(-origin.x/zoom)),y=Math.max(0,Math.floor(-origin.y/zoom));
  const right=Math.min(document.width,Math.ceil((size.width-origin.x)/zoom)),bottom=Math.min(document.height,Math.ceil((size.height-origin.y)/zoom));
  if(right<=x||bottom<=y)return null;
  const region={x,y,width:right-x,height:bottom-y};try{validatePixelGridRegion(region);return region;}catch{return null;}
}
