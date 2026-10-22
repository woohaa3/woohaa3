import { expect, it, vi } from "vitest";
import { InlineVersions, installInlineVersions } from "./inline-versions.js";
import { RUN_STATE_SERVICE } from "../service-keys.js";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
const item = (id: string, current=false) => ({entryId:id,nodeId:"n",nodeTitle:"test",kind:"image",createdAt:id,current,recoverable:true,outcome:"succeeded",previewable:true,source:{label:id},preview:{}} as unknown as NodeGenerationHistoryListItem & {nodeId:string;nodeTitle:string});
function setup(items=[item("a"),item("b",true),item("c")]) {
  const apply=vi.fn(async (_input: unknown) => ({ok:true as const}));
  const client={listCanvas:vi.fn(async()=>({ok:true as const,items,nextCursor:null,total:items.length,kindCounts:{image:items.length,text:0,video:0,audio:0,model:0}})),apply,
    list:vi.fn(),detail:vi.fn(async()=>({ok:false as const,code:"missing",error:"missing"})),previewUrl:vi.fn()};
  const report=vi.fn();
  const service=new InlineVersions(client,"canvas",report);
  return {client,service,report};
}
const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
it("bounds terminal compensation, deduplicates events, refreshes on reconnect and stops on disposal",async()=>{
  vi.useFakeTimers();
  let dispose:(()=>void)|undefined;
  try {
    let state="running", runListener=()=>{}, sessionListener=(_status:any)=>{};
    const {client}=setup([]);
    const runState={subscribe:(listener:()=>void)=>{runListener=listener;return vi.fn();},snapshot:()=>({records:[{operationId:"run",nodeId:"n",state}]})};
    const ctx={get:(key:unknown)=>key===RUN_STATE_SERVICE?runState:undefined,provide:vi.fn(),on:()=>vi.fn(),
      canvasSession:{isWritable:()=>true,subscribe:(listener:(value:any)=>void)=>{sessionListener=listener;return vi.fn();}}};
    dispose=installInlineVersions(ctx as never,"canvas",client);
    runListener();state="succeeded";runListener();runListener();
    await vi.advanceTimersByTimeAsync(1600);
    expect(client.listCanvas).toHaveBeenCalledTimes(3);
    sessionListener({remote:{phase:"offline"}});sessionListener({remote:{phase:"synced"}});await flush();
    expect(client.listCanvas).toHaveBeenCalledTimes(4);
    state="failed";runListener();dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.listCanvas).toHaveBeenCalledTimes(4);
  } finally {dispose?.();vi.useRealTimers();}
});
it("does not overwrite targeted archive compensation with a stale canvas response",async()=>{
  const {service,client}=setup();
  let release!:(value:any)=>void;
  client.listCanvas.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const loading=service.refresh();
  await service.refreshNode("n");
  release({ok:true,items:[],nextCursor:null});await loading;
  expect(service.snapshot().get("n")).toHaveLength(3);service.dispose();
});
it("contains transport failures and permits an explicit retry",async()=>{
  const {service,client,report}=setup();
  client.listCanvas.mockRejectedValueOnce(new Error("offline"));
  await service.refreshNode("n");expect(report).toHaveBeenCalledTimes(1);
  await service.refreshNode("n");expect(service.snapshot().get("n")).toHaveLength(3);service.dispose();
});
it("previews the only archived success when mixed activity made its dot visible",async()=>{
  const {service,client}=setup([item("old")]);await service.refresh();
  service.select({nodeId:"n",entryId:"old"});await flush();
  expect(client.apply).not.toHaveBeenCalled();expect(service.preview.selected.get("n")).toBe("entry:old");service.dispose();
});
it("keeps mixed metadata but never restores failed records",async()=>{
  const failed={...item("failure"),outcome:"failed" as const,recoverable:false};
  const {service,client}=setup([item("a",true),failed]);await service.refresh();
  expect(service.snapshot().get("n")).toHaveLength(2);
  service.select({nodeId:"n",step:1});await flush();expect(client.apply).not.toHaveBeenCalled();service.dispose();
});
it("rapid scrubs keep the latest local selection without any persistent apply",async()=>{
  const {service,client}=setup();await service.refresh();
  service.select({nodeId:"n",index:0});service.select({nodeId:"n",index:1});service.select({nodeId:"n",index:2});
  await flush();expect(client.apply).not.toHaveBeenCalled();
  expect(service.preview.selected.get("n")).toBe("entry:c");service.dispose();
});
it("explicit steps follow local selection and stop at bounds without writes",async()=>{
  const {service,client}=setup();await service.refresh();
  service.select({nodeId:"n",step:1});expect(client.apply).not.toHaveBeenCalled();
  service.select({nodeId:"n",step:1});await flush();
  expect(client.apply).not.toHaveBeenCalled();expect(service.preview.selected.get("n")).toBe("entry:c");service.dispose();
});
it("late metadata does not publish after page disposal",async()=>{
  const {service,client}=setup();let release!:(value:any)=>void;
  client.listCanvas.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const publish=vi.fn();service.subscribe(publish);const loading=service.refresh();service.dispose();
  release({ok:true,items:[item("a")],nextCursor:null});await loading;expect(publish).not.toHaveBeenCalled();
});
it("does not drop a new selection while metadata refresh is in flight",async()=>{
  const {service,client}=setup();await service.refresh();
  let release!:(value:any)=>void;
  client.listCanvas.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const refresh=service.refresh();service.select({nodeId:"n",index:0});await flush();
  service.select({nodeId:"n",index:2});
  release({ok:true,items:[item("a",true),item("b"),item("c")],nextCursor:null});await refresh;await flush();
  expect(client.apply).not.toHaveBeenCalled();expect(service.preview.selected.get("n")).toBe("entry:c");service.dispose();
});
