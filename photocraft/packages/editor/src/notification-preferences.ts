import {useEffect,useState} from "react";
import {EDITOR_PREFERENCES_KEY} from "./workspace-layout-memory.js";
export type NotificationPreferences={autoHide:boolean;seconds:number};
export const DEFAULT_NOTIFICATIONS:NotificationPreferences={autoHide:true,seconds:6};
const CHANGE="photocraft:notification-preferences";
export function normalizeNotifications(value:unknown):NotificationPreferences {
 const input=value && typeof value==="object"?value as Record<string,unknown>:{};
 return {autoHide:typeof input.autoHide==="boolean"?input.autoHide:true,seconds:typeof input.seconds==="number" && Number.isInteger(input.seconds) && input.seconds>=1 && input.seconds<=120?input.seconds:6};
}
export function readNotifications():NotificationPreferences {
 try{return normalizeNotifications(JSON.parse(globalThis.localStorage?.getItem(EDITOR_PREFERENCES_KEY)??"null")?.notifications);}catch{return {...DEFAULT_NOTIFICATIONS};}
}
export function publishNotifications(value:NotificationPreferences):void {
 if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent(CHANGE,{detail:normalizeNotifications(value)}));
}
export function useNotificationPreferences():NotificationPreferences {
 const [value,setValue]=useState(readNotifications);
 useEffect(()=>{
  const local=(event:Event)=>setValue(normalizeNotifications((event as CustomEvent<unknown>).detail));
  const storage=(event:StorageEvent)=>{if(event.key===null || event.key===EDITOR_PREFERENCES_KEY)setValue(readNotifications());};
  window.addEventListener(CHANGE,local);window.addEventListener("storage",storage);
  return()=>{window.removeEventListener(CHANGE,local);window.removeEventListener("storage",storage);};
 },[]);
 return value;
}
