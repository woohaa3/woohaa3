import type {DocumentPoint} from "./photo-editor-tools.js";

/** 图案 phase 使用文档像素；角度、缩放和链接不改变拖动的坐标系。 */
export type StylePositionTarget={key:string;index:number;kind:"PatternOverlay"|"BevelEmboss"|"GradientOverlay"|"Stroke"|"DropShadow"|"InnerShadow"};
export type StylePositionPort={key:string;start:(point:DocumentPoint)=>boolean;preview:(point:DocumentPoint)=>void;end:(point:DocumentPoint)=>void;cancel:()=>void};
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);
export function patternPosition(items:Record<string,unknown>[],target:StylePositionTarget):Record<string,unknown>|null {
  if(target.kind!=="PatternOverlay" && target.kind!=="BevelEmboss") return null;
  const body=items[target.index]?.[target.kind];
  if(!object(body) || (object(body.common) && body.common.enabled===false) || body.enabled===false) return null;
  const pattern=target.kind==="BevelEmboss"?body.texture:body;
  return object(pattern) && Array.isArray(pattern.phase) && pattern.phase.length===2 && pattern.phase.every(v=>typeof v==="number" && Number.isFinite(v))?pattern:null;
}
/** 每帧从按下时的完整快照计算，避免累计误差或覆盖未展示字段。 */
export function translatePattern<T extends {style:{enabled:boolean;items:Record<string,unknown>[]}}>(base:T,target:StylePositionTarget,start:DocumentPoint,end:DocumentPoint):T|null {
  if(!base.style.enabled || ![start.x,start.y,end.x,end.y].every(Number.isFinite)) return null;
  const next=structuredClone(base),pattern=patternPosition(next.style.items,target);
  if(!pattern) return null;
  const phase=pattern.phase as number[];
  const moved=[phase[0]!+end.x-start.x,phase[1]!+end.y-start.y];
  if(moved.some(v=>Math.abs(v)>1_000_000)) return null;
  pattern.phase=moved;return next;
}

/** 原生效果帧 [x, y, width, height]；视图元数据，不写工程或内容身份。 */
export type StyleGradientFrame=[number,number,number,number];
export function readStyleGradientFrame(value:unknown):StyleGradientFrame|undefined {
  return Array.isArray(value) && value.length===4 && value.every(Number.isSafeInteger)
    && value.slice(0,2).every(v=>v>=-2_147_483_648 && v<=2_147_483_647)
    && value.slice(2).every(v=>v>0 && v<=4_294_967_295)?value as StyleGradientFrame:undefined;
}
function gradientPosition(items:Record<string,unknown>[],target:StylePositionTarget):Record<string,unknown>|null {
  if(target.kind!=="GradientOverlay" && target.kind!=="Stroke") return null;
  const body=items[target.index]?.[target.kind];
  if(!object(body) || (object(body.common) && body.common.enabled===false)) return null;
  const gradient=target.kind==="Stroke"?(object(body.paint)?body.paint.Gradient:null):body.gradient;
  if(!object(gradient)) return null;
  const offset=gradient.offset;
  return Array.isArray(offset) && offset.length===2 && offset.every(v=>typeof v==="number" && Number.isFinite(v))?gradient:null;
}
type PositionData={style:{enabled:boolean;items:Record<string,unknown>[]};gradientFrame?:StyleGradientFrame;globalLight?:{angle:number}};
function shadowPosition(data:PositionData,target:StylePositionTarget):Record<string,unknown>|null {
  if(target.kind!=="DropShadow" && target.kind!=="InnerShadow") return null;
  const body=data.style.items[target.index]?.[target.kind];
  if(!object(body) || (object(body.common) && body.common.enabled===false) || typeof body.use_global_light!=="boolean") return null;
  const angle=body.use_global_light?data.globalLight?.angle:body.angle;
  return typeof angle==="number" && Number.isFinite(angle) && Math.abs(angle)<=360
    && typeof body.distance==="number" && Number.isFinite(body.distance) && body.distance>=0 && body.distance<=2048?body:null;
}
export function canPositionStyle(data:PositionData,target:StylePositionTarget):boolean {
  if(target.kind==="DropShadow" || target.kind==="InnerShadow") return data.style.enabled && !!shadowPosition(data,target);
  return data.style.enabled && (target.kind==="Stroke"?!!gradientPosition(data.style.items,target):target.kind==="GradientOverlay"?!!readStyleGradientFrame(data.gradientFrame) && !!gradientPosition(data.style.items,target):!!patternPosition(data.style.items,target));
}
export function translateStyle<T extends PositionData>(base:T,target:StylePositionTarget,start:DocumentPoint,end:DocumentPoint,strokeFrame?:StyleGradientFrame):T|null {
  if(target.kind==="DropShadow" || target.kind==="InnerShadow") {
    if(!base.style.enabled || !shadowPosition(base,target) || ![start.x,start.y,end.x,end.y].every(Number.isFinite)) return null;
    const next=structuredClone(base),shadow=shadowPosition(next,target)!;
    if(start.x===end.x && start.y===end.y) return next;
    const angle=(shadow.use_global_light?next.globalLight!.angle:shadow.angle) as number;
    const distance=shadow.distance as number,radians=angle*Math.PI/180;
    // 原生 shadow_map 对两类阴影同向位移；只在合成时舍入像素，参数保留精度。
    const x=-Math.cos(radians)*distance+end.x-start.x,y=Math.sin(radians)*distance+end.y-start.y;
    const moved=Math.hypot(x,y);
    if(!Number.isFinite(moved) || moved>2048) return null;
    shadow.distance=moved;
    const movedAngle=moved>1e-10?Math.atan2(y,-x)*180/Math.PI:angle;
    if(shadow.use_global_light) next.globalLight!.angle=movedAngle;
    else shadow.angle=movedAngle;
    return next;
  }
  if(target.kind!=="GradientOverlay" && target.kind!=="Stroke") return translatePattern(base,target,start,end);
  if(!canPositionStyle(base,target) || ![start.x,start.y,end.x,end.y].every(Number.isFinite)) return null;
  const frame=target.kind==="Stroke"?readStyleGradientFrame(strokeFrame):base.gradientFrame;
  if(!frame) return null;
  const next=structuredClone(base),gradient=gradientPosition(next.style.items,target)!;
  const offset=gradient.offset as number[];
  const moved=[offset[0]!+(end.x-start.x)/frame[2],offset[1]!+(end.y-start.y)/frame[3]];
  if(moved.some(v=>Math.abs(v)>1_000_000)) return null;
  gradient.offset=moved;return next;
}
