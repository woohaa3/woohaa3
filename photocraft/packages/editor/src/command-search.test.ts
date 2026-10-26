import {expect,it} from "vitest";
import {commandSearchEntries,searchCommands,type SearchEntry} from "./command-search.js";
const entries:SearchEntry[]=[{id:"layer.renameLayer",label:"重命名图层",path:"图层",enabled:true},{id:"layer.delete",label:"删除图层",path:"图层",enabled:false},{id:"tool:brush",label:"画笔",path:"工具",enabled:true}];
it("搜索支持中文、菜单路径、命令id及模糊子序列，空查询按最近执行排序",()=>{
 expect(searchCommands(entries,"重层",[]).map(entry=>entry.id)).toEqual(["layer.renameLayer"]);
 expect(searchCommands(entries,"图层 删除",[]).map(entry=>entry.id)).toEqual(["layer.delete"]);
 expect(searchCommands(entries,"工具",[]).map(entry=>entry.id)).toEqual(["tool:brush"]);
 expect(searchCommands(entries,"layer.rename",[]).map(entry=>entry.id)).toEqual(["layer.renameLayer"]);
 expect(searchCommands(entries,"",["tool:brush"]).map(entry=>entry.id)[0]).toBe("tool:brush");
 expect(searchCommands(entries,"无此命令",[])).toEqual([]);
});

it("全局清理以宿主聚合可用态为准，但不能绕过内核allowed门禁",()=>{
 const controller={snapshot:()=>({view:{document:null},commands:new Map([["edit.purge.histories",{allowed:true,enabled:false,disabledReason:"当前无历史"}],["edit.purge.clipboard",{allowed:false,enabled:true}]])})} as unknown as import("./editor-workspace.js").EditorWorkspaceController;
 const purge={commands:{"edit.purge.histories":{enabled:true},"edit.purge.clipboard":{enabled:true},"edit.purge.all":{enabled:false}},execute:()=>({ok:true})};
 expect(commandSearchEntries(controller,purge).filter(entry=>entry.id.startsWith("edit.purge.")).map(entry=>[entry.id,entry.enabled])).toEqual([["edit.purge.histories",true]]);
});

it("主题及亮度菜单可通过路径或命令名搜索，不依赖文档写命令能力",()=>{
 const controller={snapshot:()=>({view:{document:null},commands:new Map()})} as unknown as import("./editor-workspace.js").EditorWorkspaceController;
 const entries=commandSearchEntries(controller);expect(searchCommands(entries,"窗口 主题",[])).toHaveLength(15);expect(searchCommands(entries,"view.lightenInterface",[])[0]).toMatchObject({enabled:true,shortcut:"Mod+Shift+F2"});
});

it("工具变体具有独立身份，精确工具名优先于包含该名称的其他工具",()=>{
 const controller={snapshot:()=>({view:{document:{}},commands:new Map()})} as unknown as import("./editor-workspace.js").EditorWorkspaceController;
 const entries=commandSearchEntries(controller);
 expect(new Set(entries.map(entry=>entry.id)).size).toBe(entries.length);
 expect(searchCommands(entries,"画笔",[])[0]).toMatchObject({id:"tool:brush",tool:"brush",label:"画笔"});
 expect(searchCommands(entries,"椭圆选框",[])[0]).toMatchObject({tool:"marquee",variant:"ellipse"});
 expect(searchCommands(entries,"竖排文字",[])[0]).toMatchObject({tool:"text",variant:"vertical"});
});
it("子菜单路径在名称之前匹配，例如删除图层",()=>{
 expect(searchCommands([{id:"layer.delete",label:"图层",path:"图层 › 删除",enabled:true}],"删除图层",[])[0]?.id).toBe("layer.delete");
});
