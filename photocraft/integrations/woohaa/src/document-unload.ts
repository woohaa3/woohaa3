/** Browser unload is synchronous: request its generic prompt, never start a save here. */
export function installDocumentUnloadGuard(target:EventTarget,needsProtection:()=>boolean):()=>void {
 const onBeforeUnload=(event:Event)=>{
  if(!needsProtection())return;
  event.preventDefault();
  (event as BeforeUnloadEvent).returnValue="";
 };
 target.addEventListener("beforeunload",onBeforeUnload);
 return ()=>target.removeEventListener("beforeunload",onBeforeUnload);
}
