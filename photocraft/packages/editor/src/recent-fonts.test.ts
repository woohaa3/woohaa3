import {expect,it} from "vitest";
import {RecentFonts,fontMenuFamilies} from "./recent-fonts.js";
import {DEFAULT_EDITOR_PREFERENCES,normalizeEditorPreferences} from "./editor-preferences.js";

it("Recent字体只在页面会话重排去重，降低上限和关闭后不恢复已清除项",()=>{
 const store=new RecentFonts(),events:unknown[]=[];const dispose=store.subscribe(()=>events.push(store.snapshot()));
 store.note("Inter",10);store.note("Noto Sans SC",10);store.note("Inter",10);expect(store.snapshot()).toEqual(["Inter","Noto Sans SC"]);
 store.note("Inter",10);expect(events).toHaveLength(3);store.limit(1);expect(store.snapshot()).toEqual(["Inter"]);store.limit(0);store.limit(10);expect(store.snapshot()).toEqual([]);dispose();store.note("Inter",10);expect(events).toHaveLength(5);
 expect(new RecentFonts().snapshot()).toEqual([]);
});
it("字体名称偏好只改变标签与排序，双语搜索保持稳定族名；最近字体数量严格0至50",()=>{
 expect(fontMenuFamilies(true,"").map(item=>item.display)).toEqual(["Inter","Noto Sans SC"]);
 expect(fontMenuFamilies(false,"思源")).toMatchObject([{id:"Noto Sans SC",display:"思源黑体"}]);expect(fontMenuFamilies(true,"思源")).toMatchObject([{id:"Noto Sans SC",display:"Noto Sans SC"}]);expect(fontMenuFamilies(false,"noto")).toMatchObject([{id:"Noto Sans SC"}]);expect(fontMenuFamilies(false,"missing")).toEqual([]);
 expect(DEFAULT_EDITOR_PREFERENCES.showFontNamesInEnglish).toBe(true);for(const recentFonts of [-1,51,1.5,"10",null])expect(normalizeEditorPreferences({recentFonts}).recentFonts).toBe(10);for(const recentFonts of [0,1,10,50])expect(normalizeEditorPreferences({recentFonts}).recentFonts).toBe(recentFonts);
});
