export type CursorPreferences={painting:"standard"|"precise"|"normalTip"|"fullSizeTip";center:boolean;paintingCrosshairOnly:boolean;other:"standard"|"precise"};
export const DEFAULT_CURSORS:CursorPreferences={painting:"normalTip",center:false,paintingCrosshairOnly:false,other:"standard"};
export function normalizeCursors(value:unknown):CursorPreferences{
 const raw=value && typeof value==="object"?value as Record<string,unknown>:{};
 return {painting:["standard","precise","normalTip","fullSizeTip"].includes(raw.painting as string)?raw.painting as CursorPreferences["painting"]:"normalTip",center:typeof raw.center==="boolean"?raw.center:false,paintingCrosshairOnly:typeof raw.paintingCrosshairOnly==="boolean"?raw.paintingCrosshairOnly:false,other:raw.other==="precise"?"precise":"standard"};
}
const table=[[0,.664],[.14,.58],[.28,.50],[.40,.44],[.52,.36],[.63,.29],[.70,.24],[.78,.19],[.84,.15],[.89,.11],[1,0]];
/** Pinned photocraft-paint::half_coverage_radius / tip_shape, for the supported round tip. */
export function normalTipRadius(radius:number,hardness:number):number{
 const r=Number.isFinite(radius)?Math.max(0,radius):0,h=(Number.isNaN(hardness)?0:Math.max(0,Math.min(1,hardness)))*10,index=Math.min(9,Math.floor(h)),fraction=h-index;
 const a=table[index],b=table[index+1],core=a[0]+(b[0]-a[0])*fraction,shoulder=a[1]+(b[1]-a[1])*fraction,edge=Math.max(.25,Math.min(1.2,.3*r));
 return Math.max(0,Math.min(core*r,r-edge))+Math.max(1e-3,edge,shoulder*r)*Math.sqrt(64*(1-Math.pow(.5,1/64)));
}
export function brushCursor(preferences:CursorPreferences,size:number,hardness:number,zoom:number,painting:boolean,block=false){
 const radius=Math.max(0,size*zoom/2),normal=preferences.painting==="normalTip",outline=normal?normalTipRadius(radius,hardness):radius;
 if(block)return {mode:"outline" as const,diameter:16,center:preferences.center,block:true};
 if(preferences.painting==="precise" || painting && preferences.paintingCrosshairOnly)return {mode:"precise" as const,diameter:0,center:false,block:false};
 if(preferences.painting==="standard")return {mode:"standard" as const,diameter:0,center:false,block:false};
 if(outline<3)return {mode:"precise" as const,diameter:0,center:false,block:false};
 return {mode:"outline" as const,diameter:Math.max(2,outline*2),center:preferences.center,block:false};
}
