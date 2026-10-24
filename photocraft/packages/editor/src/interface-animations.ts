/** Editor chrome motion policy; portals and host-registered dialogs share this local preference. */
import {EDITOR_PREFERENCES_KEY} from "./workspace-layout-memory.js";
const CHANGE="photocraft:interface-animations";
export function readInterfaceAnimations():boolean {
 try{const value=JSON.parse(globalThis.localStorage?.getItem(EDITOR_PREFERENCES_KEY)??"null");return typeof value?.enableAnimations==="boolean"?value.enableAnimations:true;}catch{return true;}
}
export function publishInterfaceAnimations(enabled:boolean):void {
 if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(CHANGE,{detail:enabled}));
}
export function subscribeInterfaceAnimations(change:(enabled:boolean)=>void):()=>void {
 if(typeof window==="undefined")return()=>{};
 const local=(event:Event)=>{const value=(event as CustomEvent<unknown>).detail;if(typeof value==="boolean")change(value);};
 const storage=(event:StorageEvent)=>{if(event.key===null || event.key===EDITOR_PREFERENCES_KEY)change(readInterfaceAnimations());};
 window.addEventListener(CHANGE,local);window.addEventListener("storage",storage);
 return()=>{window.removeEventListener(CHANGE,local);window.removeEventListener("storage",storage);};
}
