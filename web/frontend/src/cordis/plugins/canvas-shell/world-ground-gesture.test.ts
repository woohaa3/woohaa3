import {afterEach,expect,it,vi} from "vitest";
import {createEmptyWoohaa3ServerCanvas,createWorldAnimationScript} from "@woohaa3/contracts";
import {woohaa3CanvasStore} from "../../services/canvas-state/index.js";
import {createWorldGroundGestureFamily} from "./world-ground-gesture.js";
import {beginWorldGroundDrag} from "./world-ground-drag.js";
import {setWorldUnbindConfirmer} from "./world-unbind-confirm.js";
import type {InteractionCore} from "./interaction-core.js";
afterEach(()=>setWorldUnbindConfirmer(null));
function fixture(session:unknown){
 const canvas=createEmptyWoohaa3ServerCanvas("unbind-test");
 canvas.document.nodes=[{id:"model",type:"model3d"},{id:"area",type:"scene-area"}];
 canvas.nodeData.model={sharedWorldInstance:{kind:"world-instance",version:"shared-world-v1",instanceId:"actor",transform:{version:"shared-world-v1",position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1}}};
 canvas.nodeData.area={sceneArea:{kind:"scene-area",version:"shared-world-v1",areaId:"director",scopeVersion:"v1",bounds:{min:{u:-1,v:-1},max:{u:1,v:1}},animationScript:createWorldAnimationScript({script:'motion.instance.tween("actor",{property:"position",startTime:0,endTime:1,from:[0,0,0],to:[0.5,0,0]});',duration:1,loop:false})}} as never;
 woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
 const history=vi.fn(),errors=vi.fn();let seq=0;
 const core={state:{gesture:{kind:"world-ground",pointerId:1,start:beginWorldGroundDrag(canvas,"model",{u:0,v:0}),delta:{u:0,v:0}}},options:{getSession:()=>session,getWorldAnimationTimes:()=>new Map([["area",0]]),recordExternal:history,onInteractionError:errors},queryWorldGround:()=>({u:3,v:0}),clearWorldGroundPreviews:vi.fn(),schedule:vi.fn(),writable:()=>true,submit:vi.fn(),nextSeq:()=>seq++} as unknown as InteractionCore;
 return {family:createWorldGroundGestureFamily(core),history,errors};
}
const release={pointerId:1,clientX:0,clientY:0} as PointerEvent;
it("uses fresh IDs after controller recreation and for undo/redo",async()=>{
 const ids:string[]=[];
 const session={submitCommands:vi.fn((_commands:unknown,id:string)=>{ids.push(id);return {ok:true,handle:{settled:Promise.resolve({state:"committed"})}};})};
 setWorldUnbindConfirmer(async()=>true);
 const first=fixture(session);first.family.commit(release);
 await vi.waitFor(()=>expect(first.history).toHaveBeenCalledTimes(1));
 const second=fixture(session);second.family.commit(release);
 await vi.waitFor(()=>expect(second.history).toHaveBeenCalledTimes(1));
 expect(new Set(ids).size).toBe(2);
 const entry=second.history.mock.calls[0]![0];
 await entry.undo();await entry.redo();
 expect(new Set(ids).size).toBe(4);
});
it("waits for committed settlement before recording undo and reports remote rejection",async()=>{
 let settle!:(value:unknown)=>void;
 const session={submitCommands:()=>({ok:true,handle:{settled:new Promise(resolve=>{settle=resolve;})}})};
 setWorldUnbindConfirmer(async()=>true);
 const f=fixture(session);f.family.commit(release);
 await vi.waitFor(()=>expect(settle).toBeTypeOf("function"));
 expect(f.history).not.toHaveBeenCalled();
 settle({state:"rejected",error:"command-id-reused"});
 await vi.waitFor(()=>expect(f.errors).toHaveBeenCalledTimes(1));
 expect(f.history).not.toHaveBeenCalled();
});
it("reports an immediate rejected submission without adding undo",async()=>{
 setWorldUnbindConfirmer(async()=>true);
 const f=fixture({submitCommands:()=>({ok:false,reason:"host reconnecting"})});f.family.commit(release);
 await vi.waitFor(()=>expect(f.errors).toHaveBeenCalledTimes(1));
 expect(f.history).not.toHaveBeenCalled();
});

it("reports history registration failure truthfully after a committed move",async()=>{
 setWorldUnbindConfirmer(async()=>true);
 const f=fixture({submitCommands:()=>({ok:true,handle:{settled:Promise.resolve({state:"committed"})}})});
 f.history.mockReturnValue({ok:false,reason:"history busy"});
 f.family.commit(release);
 await vi.waitFor(()=>expect(f.errors).toHaveBeenCalledTimes(1));
 expect((f.errors.mock.calls[0]![0] as Error).message).toContain("已保存");
 expect((f.errors.mock.calls[0]![0] as Error).message).toContain("撤销");
});
