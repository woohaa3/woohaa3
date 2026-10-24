/** Local workspace persistence policy; independent of document content and native commands. */
export const EDITOR_PREFERENCES_KEY="photocraft.editor-preferences.v1";
const CHANGE="photocraft:remember-workspace-changes";
export function readRememberWorkspaceChanges():boolean{
 try{return JSON.parse(globalThis.localStorage?.getItem(EDITOR_PREFERENCES_KEY)??"null")?.rememberWorkspaceChanges!==false;}catch{return true;}
}
export function publishRememberWorkspaceChanges(remember:boolean):void{
 if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(CHANGE,{detail:remember}));
}
export function subscribeRememberWorkspaceChanges(change:(value:boolean)=>void):()=>void{
 if(typeof window==="undefined")return()=>{};
 const local=(event:Event)=>{const value=(event as CustomEvent<unknown>).detail;if(typeof value==="boolean")change(value);};
 const storage=(event:StorageEvent)=>{if(event.key===null || event.key===EDITOR_PREFERENCES_KEY)change(readRememberWorkspaceChanges());};
 window.addEventListener(CHANGE,local);window.addEventListener("storage",storage);
 return()=>{window.removeEventListener(CHANGE,local);window.removeEventListener("storage",storage);};
}
export const WORKSPACE_VISIBILITY_KEY="woohaa.image-editor.workspace-visibility.v1";
const defaults={toolsVisible:true,optionsVisible:true,sidebarVisible:true,navigatorVisible:false,histogramVisible:false,infoVisible:false,modifiersVisible:false,cloneSourceVisible:false,brushPresetsVisible:false};
export type WorkspaceVisibility=typeof defaults;
export function readWorkspaceVisibility():WorkspaceVisibility{
 if(!readRememberWorkspaceChanges())return {...defaults};
 try{const value=JSON.parse(localStorage.getItem(WORKSPACE_VISIBILITY_KEY)??"null");return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,typeof value?.[key]==="boolean"?value[key]:fallback])) as WorkspaceVisibility;}catch{return {...defaults};}
}
export function saveWorkspaceVisibility(value:Partial<WorkspaceVisibility>):void{
 if(!readRememberWorkspaceChanges())return;
 const next=Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,typeof value[key as keyof WorkspaceVisibility]==="boolean"?value[key as keyof WorkspaceVisibility]:fallback]));
 try{localStorage.setItem(WORKSPACE_VISIBILITY_KEY,JSON.stringify(next));}catch{/* Session controls remain usable. */}
}

const LARGE_TABS_CHANGE="photocraft:large-document-tabs";
export function readLargeDocumentTabs():boolean{
 try{return JSON.parse(globalThis.localStorage?.getItem(EDITOR_PREFERENCES_KEY)??"null")?.largeDocumentTabs===true;}catch{return false;}
}
export function publishLargeDocumentTabs(large:boolean):void{
 if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(LARGE_TABS_CHANGE,{detail:large}));
}
export function subscribeLargeDocumentTabs(change:(value:boolean)=>void):()=>void{
 if(typeof window==="undefined")return()=>{};
 const local=(event:Event)=>{const value=(event as CustomEvent<unknown>).detail;if(typeof value==="boolean")change(value);};
 const storage=(event:StorageEvent)=>{if(event.key===null || event.key===EDITOR_PREFERENCES_KEY)change(readLargeDocumentTabs());};
 window.addEventListener(LARGE_TABS_CHANGE,local);window.addEventListener("storage",storage);
 return()=>{window.removeEventListener(LARGE_TABS_CHANGE,local);window.removeEventListener("storage",storage);};
}

const NARROW_OPTIONS_CHANGE="photocraft:narrow-options-bar";
export function readNarrowOptionsBar():boolean{
 try{return JSON.parse(globalThis.localStorage?.getItem(EDITOR_PREFERENCES_KEY)??"null")?.narrowOptionsBar===true;}catch{return false;}
}
export function publishNarrowOptionsBar(narrow:boolean):void{
 if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(NARROW_OPTIONS_CHANGE,{detail:narrow}));
}
export function subscribeNarrowOptionsBar(change:(value:boolean)=>void):()=>void{
 if(typeof window==="undefined")return()=>{};
 const local=(event:Event)=>{const value=(event as CustomEvent<unknown>).detail;if(typeof value==="boolean")change(value);};
 const storage=(event:StorageEvent)=>{if(event.key===null || event.key===EDITOR_PREFERENCES_KEY)change(readNarrowOptionsBar());};
 window.addEventListener(NARROW_OPTIONS_CHANGE,local);window.addEventListener("storage",storage);
 return()=>{window.removeEventListener(NARROW_OPTIONS_CHANGE,local);window.removeEventListener("storage",storage);};
}
