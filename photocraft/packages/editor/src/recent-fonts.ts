import {useSyncExternalStore} from "react";

export const EDITOR_FONT_FAMILIES=[{id:"Noto Sans SC",label:"思源黑体"},{id:"Inter",label:"Inter"}] as const;
export type EditorFontFamily=(typeof EDITOR_FONT_FAMILIES)[number]["id"];
/** 页面会话共享，与文档、工程、撤销和本机工具记忆分开。 */
export class RecentFonts {
  private fonts:readonly EditorFontFamily[]=[];
  private listeners=new Set<()=>void>();
  snapshot=()=>this.fonts;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  limit(count:number){this.publish(this.fonts.slice(0,count));}
  note(font:EditorFontFamily,count:number){this.publish([font,...this.fonts.filter(item=>item!==font)].slice(0,count));}
  private publish(fonts:readonly EditorFontFamily[]){if(fonts.length===this.fonts.length && fonts.every((font,index)=>font===this.fonts[index]))return;this.fonts=fonts;for(const listener of this.listeners)listener();}
}
export const recentFonts=new RecentFonts();
export const useRecentFonts=()=>useSyncExternalStore(recentFonts.subscribe,recentFonts.snapshot,recentFonts.snapshot);
export function fontMenuFamilies(english:boolean,query:string){
  const match=query.trim().toLocaleLowerCase();
  return EDITOR_FONT_FAMILIES.map(item=>({...item,display:english?item.id:item.label})).filter(item=>!match || `${item.id} ${item.label}`.toLocaleLowerCase().includes(match)).sort((a,b)=>a.display.localeCompare(b.display,"zh-CN"));
}
