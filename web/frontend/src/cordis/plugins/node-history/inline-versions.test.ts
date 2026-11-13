import { expect, it, vi } from "vitest";
import { InlineVersions, installInlineVersions } from "./inline-versions.js";
import { RUN_STATE_SERVICE } from "../service-keys.js";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
const item = (id: string, current=false) => ({entryId:id,nodeId:"n",nodeTitle:"test",kind:"image",createdAt:id,current,recoverable:true,outcome:"succeeded",previewable:true,source:{label:id},preview:{}} as unknown as NodeGenerationHistoryListItem & {nodeId:string;nodeTitle:string});
function setup(items=[item("a"),item("b",true),item("c")], storage?: Pick<Storage,"getItem"|"setItem">|null) {
  const apply=vi.fn(async (_input: unknown) => ({ok:true as const}));
  const client={listCanvas:vi.fn(async()=>({ok:true as const,items,nextCursor:null,total:items.length,kindCounts:{image:items.length,text:0,video:0,audio:0,motion:0,model:0}})),apply,
    list:vi.fn(),detail:vi.fn(async()=>({ok:false as const,code:"missing",error:"missing"})),previewUrl:vi.fn()};
  const report=vi.fn();
  const onApplyError=vi.fn();
  const service=new InlineVersions(client,"canvas",report,onApplyError,undefined,storage);
  return {client,service,report,onApplyError};
}
const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
it("bounds terminal compensation, deduplicates events, refreshes on reconnect and stops on disposal",async()=>{
  vi.useFakeTimers();
  let dispose:(()=>void)|undefined;
  try {
    let state="running", runListener=()=>{}, sessionListener=(_status:any)=>{};
    const {client}=setup([]);
    const runState={subscribe:(listener:()=>void)=>{runListener=listener;return vi.fn();},snapshot:()=>({records:[{operationId:"run",nodeId:"n",state}]})};
    // inject 是真实 Context 的声明式依赖入口：这里让替身"立刻可用"，保持用例仍走装配后的正常路径。
    const inject=(_deps:unknown,_callback:(scoped:any)=>void)=>{_callback({get:(key:unknown)=>key===RUN_STATE_SERVICE?runState:undefined,effect:vi.fn()});};
    const ctx={inject,get:(key:unknown)=>key===RUN_STATE_SERVICE?runState:undefined,provide:vi.fn(),on:()=>vi.fn(),
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
  expect(client.apply).not.toHaveBeenCalled();expect(service.selectedByNode().get("n")).toBe("entry:old");service.dispose();
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
  expect(service.selectedByNode().get("n")).toBe("entry:c");service.dispose();
});
it("explicit steps follow local selection and stop at bounds without writes",async()=>{
  const {service,client}=setup();await service.refresh();
  service.select({nodeId:"n",step:1});expect(client.apply).not.toHaveBeenCalled();
  service.select({nodeId:"n",step:1});await flush();
  expect(client.apply).not.toHaveBeenCalled();expect(service.selectedByNode().get("n")).toBe("entry:c");service.dispose();
});
it("direct dot activation shows the target immediately and applies it",async()=>{
  const {service,client}=setup();await service.refresh();
  service.activate({nodeId:"n",entryId:"a"});await flush();
  expect(client.apply).toHaveBeenCalledWith({canvasId:"canvas",nodeId:"n",entryId:"a"});
  expect(service.selectedByNode().get("n")).toBe("entry:a");
  service.dispose();
});
it("direct activation switches an existing read-only preview to the target",async()=>{
  const {service}=setup();await service.refresh();
  service.select({nodeId:"n",entryId:"a"});await flush();
  expect(service.selectedByNode().get("n")).toBe("entry:a");
  service.activate({nodeId:"n",entryId:"c"});await flush();
  expect(service.selectedByNode().get("n")).toBe("entry:c");
  service.dispose();
});
it("keeps the applied entry visible after it is confirmed current",async()=>{
  const items=[item("a",true),item("c")];
  const {service,client}=setup(items);await service.refresh();
  client.apply.mockImplementationOnce(async()=>{
    items[0]={...items[0],current:false};
    items[1]={...items[1],current:true};
    return {ok:true as const};
  });
  service.activate({nodeId:"n",entryId:"c"});await flush();
  expect(service.selectedByNode().get("n")).toBe("entry:c");
  service.dispose();
});
it("current and unrecoverable dots never apply",async()=>{
  const failed={...item("failure"),outcome:"failed" as const,recoverable:false};
  const {service,client}=setup([item("a",true),failed]);
  await service.refresh();
  service.activate({nodeId:"n",entryId:"a"});await flush();
  service.activate({nodeId:"n",entryId:"failure"});await flush();
  expect(client.apply).not.toHaveBeenCalled();
  expect(service.selectedByNode().get("n")).toBe("entry:failure");
  service.dispose();
});
it("blocks direct activation when the host reports an unsaved draft or running task",async()=>{
  const {service,client,onApplyError}=setup();
  const guarded=new InlineVersions(client,"canvas",vi.fn(),onApplyError,()=>({ok:false,reason:"请先保存当前草稿"}));
  try {
    await guarded.refresh();
    guarded.activate({nodeId:"n",entryId:"a"});await flush();
    expect(client.apply).not.toHaveBeenCalled();
    expect(onApplyError).toHaveBeenCalledWith({nodeId:"n",error:"请先保存当前草稿"});
  } finally { guarded.dispose(); }
  service.dispose();
});
it("marks newly archived versions unseen until the dot or panel is seen",async()=>{
  const items=[item("a"),item("b",true)];
  const {service}=setup(items);await service.refresh();
  expect(service.unseenSnapshot().size).toBe(0);
  items.push(item("d"));
  await service.refreshNode("n");
  expect(service.unseenSnapshot().get("n")?.has("d")).toBe(true);
  service.activate({nodeId:"n",entryId:"d"});await flush();
  expect(service.unseenSnapshot().size).toBe(0);
  items.push(item("e"));
  await service.refreshNode("n");
  expect(service.unseenSnapshot().get("n")?.has("e")).toBe(true);
  service.markSeenNode("n");
  expect(service.unseenSnapshot().size).toBe(0);
  service.dispose();
});
it("persists the per-node seen baseline across service instances",async()=>{
  const data=new Map<string,string>();
  const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const items=[item("a"),item("b",true)];
  const first=setup(items,storage);await first.service.refresh();first.service.dispose();
  items.push(item("d"));
  const second=setup(items,storage);await second.service.refresh();
  expect(second.service.unseenSnapshot().get("n")?.has("d")).toBe(true);
  second.service.dispose();
});
it("baselines an empty-history node so its first completed version is unseen",async()=>{
  const items: ReturnType<typeof item>[] = [];
  const {service}=setup(items);service.baselineNodes(["n"]);
  items.push(item("d"));
  await service.refreshNode("n");
  expect(service.unseenSnapshot().get("n")?.has("d")).toBe(true);
  service.dispose();
});
it("does not mark failed or other red terminal versions unseen",async()=>{
  const items=[item("a")];
  const {service}=setup(items);await service.refresh();
  items.push({...item("f"), outcome:"failed" as const, recoverable:false, createdAt:"z"});
  await service.refreshNode("n");
  expect(service.unseenSnapshot().size).toBe(0);
  service.dispose();
});
it("keeps an unarchived running dot selectable after a green dot was activated",async()=>{
  const items=[item("a",true),item("b")];
  const {service,client}=setup(items);await service.refresh();
  service.observeRunState([{operationId:"run",canvasId:"canvas",nodeId:"n",kind:"image",state:"running",owner:"server",createdAt:"r",updatedAt:"r"} as never]);
  service.activate({nodeId:"n",entryId:"b",presentationId:"entry:b"});await flush();
  expect(client.apply).toHaveBeenCalledTimes(1);
  service.activate({nodeId:"n",presentationId:"operation:run",operationId:"run"});await flush();
  expect(client.apply).toHaveBeenCalledTimes(1);
  expect(service.selectedByNode().get("n")).toBe("operation:run");
  service.dispose();
});
it("keeps a previewed running version selected when it settles and treats its archive as seen",async()=>{
  const items=[item("a")];
  const {service}=setup(items);await service.refresh();
  const record=(state:"running"|"succeeded")=>({operationId:"run",canvasId:"canvas",nodeId:"n",kind:"image",state,owner:"server",createdAt:"r",updatedAt:"r"}) as never;
  service.observeRunState([record("running")]);
  expect(service.selectedByNode().get("n")).toBe("operation:run");
  service.observeRunState([record("succeeded")]);
  expect(service.selectedByNode().get("n")).toBe("operation:run");
  items.push({...item("z"), source:{label:"z",runId:"run"}, createdAt:"z"});
  await service.refreshNode("n");
  expect(service.selectedByNode().get("n")).toBe("operation:run");
  expect(service.unseenSnapshot().size).toBe(0);
  service.dispose();
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
  expect(client.apply).not.toHaveBeenCalled();expect(service.selectedByNode().get("n")).toBe("entry:c");service.dispose();
});
