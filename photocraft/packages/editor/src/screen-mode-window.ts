import {useCallback,useEffect,useRef} from "react";
import type {EditorScreenMode} from "./editor-display.js";

/** Public window boundary: a native/web host can supply its own fullscreen implementation. */
export interface EditorScreenModeWindowPort {
  isFullscreen():boolean;
  requestFullscreen():Promise<void>;
  exitFullscreen():Promise<void>;
  subscribe(listener:()=>void):()=>void;
}
export const browserScreenModeWindow:EditorScreenModeWindowPort={
  isFullscreen:()=>typeof document!=="undefined" && !!document.fullscreenElement,
  requestFullscreen:()=>document.documentElement.requestFullscreen(),
  exitFullscreen:()=>document.fullscreenElement===document.documentElement?document.exitFullscreen():Promise.resolve(),
  subscribe:listener=>{document.addEventListener("fullscreenchange",listener);return()=>document.removeEventListener("fullscreenchange",listener);}
};

/** Own only the fullscreen request initiated by this workspace. Host portals stay in the same tree. */
export function useScreenModeWindow(publish:(mode:EditorScreenMode,error?:string)=>void,windowPort:EditorScreenModeWindowPort=browserScreenModeWindow) {
  const latest=useRef(publish);latest.current=publish;
  const owned=useRef(false),pending=useRef(false),mounted=useRef(true),mode=useRef<EditorScreenMode>("standard");
  const emit=useCallback((next:EditorScreenMode,error?:string)=>{if(mounted.current){mode.current=next;latest.current(next,error);}},[]);
  useEffect(()=>{
    mounted.current=true;
    const changed=()=>{if(!windowPort.isFullscreen()){owned.current=false;if(mode.current!=="standard")emit("standard");}};
    const unsubscribe=windowPort.subscribe(changed);
    return()=>{mounted.current=false;unsubscribe();if(owned.current){owned.current=false;if(windowPort.isFullscreen())void windowPort.exitFullscreen().catch(()=>undefined);}};
  },[emit,windowPort]);
  return useCallback((next:EditorScreenMode)=>{
    if(pending.current)return;
    const fail=()=>emit("standard","无法切换窗口全屏，请检查浏览器的全屏权限。");
    if(next==="standard"){
      if(owned.current && windowPort.isFullscreen()){
        const previous=mode.current;pending.current=true;
        try {void windowPort.exitFullscreen().then(()=>{owned.current=false;emit(next);}).catch(()=>emit(previous,"无法退出窗口全屏，请使用浏览器的退出全屏操作。")).finally(()=>{pending.current=false;});}
        catch {pending.current=false;emit(previous,"无法退出窗口全屏，请使用浏览器的退出全屏操作。");}
      }else emit(next);
      return;
    }
    if(windowPort.isFullscreen()){emit(next);return;}
    pending.current=true;
    // Remain in the original trusted click/key call, before any await.
    try {
      void windowPort.requestFullscreen().then(()=>{
        if(!mounted.current){if(windowPort.isFullscreen())void windowPort.exitFullscreen().catch(()=>undefined);return;}
        if(!windowPort.isFullscreen()){fail();return;}
        owned.current=true;emit(next);
      }).catch(fail).finally(()=>{pending.current=false;});
    } catch {pending.current=false;fail();}
  },[emit,windowPort]);
}
