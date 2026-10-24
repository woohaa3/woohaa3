/** Capture the batch once. Keep the active tab until all background targets settle. */
export function documentCloseTargets(entries:readonly {id:string}[],activeId:string|null,mode:"all"|"others"):string[] {
 const background=entries.filter(entry=>entry.id!==activeId).map(entry=>entry.id);
 return mode==="all"&&activeId&&entries.some(entry=>entry.id===activeId)?[...background,activeId]:background;
}
/** False is cancellation or failure: already closed documents stay closed, later ones stay open. */
export async function closeDocumentBatch(ids:readonly string[],close:(id:string)=>Promise<boolean>,active:()=>boolean=()=>true):Promise<boolean> {
 for(const id of ids){if(!active()||!await close(id))return false;}
 return true;
}
