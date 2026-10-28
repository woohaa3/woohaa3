export type WorkDiagnosticResult = {value:Record<string,unknown>|null;reason:string|null};
/** Native reads use the existing async RPC; this path is sampled at most once a second. */
export async function readSceneWorkDiagnostics(module:{async_canvas_work_diagnostics?:()=>Promise<string>;canvas_work_diagnostics?:()=>string}):Promise<WorkDiagnosticResult> {
  if(!module.async_canvas_work_diagnostics && !module.canvas_work_diagnostics) return {value:null,reason:'unsupported'};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = module.async_canvas_work_diagnostics ? module.async_canvas_work_diagnostics() : Promise.resolve(module.canvas_work_diagnostics!());
    const raw = await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),1500);})]);
    const value: unknown=JSON.parse(raw);
    if(!value || typeof value!=="object" || Array.isArray(value)) return {value:null,reason:"invalid-diagnostics"};
    return {value:value as Record<string,unknown>,reason:null};
  } catch {return {value:null,reason:'unavailable-or-timeout'};}
  finally {if(timer) clearTimeout(timer);}
}
