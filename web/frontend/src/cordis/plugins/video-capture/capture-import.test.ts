import { expect, it, vi } from "vitest";
import { OpenCaptureFrames } from "./capture-frames.js";
import type { MediaRemoteService } from "../../contracts.js";
import type { CanvasSession } from "../../services/canvas-session.js";

it.each(["abort", "dispose", "remove"])("%s during upload prevents late canvas submission", async kind => {
  let finish!:(value:unknown)=>void;
  const upload=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
  const submitCommands=vi.fn();
  const abort=new AbortController();let exists=true;
  const manager=new OpenCaptureFrames({mediaRemote:{upload} as unknown as MediaRemoteService,
    session:{isWritable:()=>true,submitCommands} as unknown as CanvasSession,
    resolveNodePosition:()=>exists?{x:0,y:0}:null});
  // Node 22 provides File, this test does not decode/render pixels.
  const pending=manager.addFrames([{id:"f",blob:new Blob(["png"]),url:"",selected:true,timeSeconds:1}],"video",abort.signal);
  if(kind==="abort") abort.abort();else if(kind==="dispose") manager.dispose();else exists=false;
  finish({ok:true,media:{storageKey:"key",checksum:"sum",contentType:"image/png",size:3,url:"/api/media/key"}});
  const results=await pending;
  expect(results[0]!.ok).toBe(false);expect(submitCommands).not.toHaveBeenCalled();
});
