import {useEffect,useRef,useState} from "react";
import {useNotificationPreferences} from "@woohaa3/photocraft-editor";
import {Button} from "@woohaa3/photocraft-editor/ui";
export type WorkspaceNotice={message:string;tone:"info"|"error"};
/** Only the notice event is timed; document errors and unsaved state retain their own owners. */
export function WorkspaceNotification({notice,onDismiss}:{notice:WorkspaceNotice;onDismiss?:(notice:WorkspaceNotice)=>void}) {
 const preferences=useNotificationPreferences(),[hovered,setHovered]=useState(false),[dismissed,setDismissed]=useState<WorkspaceNotice|null>(null);
 const closed=useRef<WorkspaceNotice|null>(null);
 const latest=useRef({notice,onDismiss});latest.current={notice,onDismiss};
 const dismiss=(expected:WorkspaceNotice)=>{if(latest.current.notice!==expected || closed.current===expected)return;closed.current=expected;setDismissed(expected);latest.current.onDismiss?.(expected);};
 useEffect(()=>{
  if(!preferences.autoHide || hovered || dismissed===notice)return;
  let active=true;const timer=setTimeout(()=>{if(active)dismiss(notice);},preferences.seconds*1000);
  return()=>{active=false;clearTimeout(timer);};
 },[notice,preferences.autoHide,preferences.seconds,hovered,dismissed]);
 if(dismissed===notice)return null;
 return <div className="image-edit-workspace__notification" data-workspace-notification data-tone={notice.tone}
  onPointerEnter={()=>setHovered(true)} onPointerLeave={()=>setHovered(false)}>
   <p>{notice.message}</p><Button size="sm" tone="ghost" onClick={()=>dismiss(notice)}>关闭</Button>
 </div>;
}
