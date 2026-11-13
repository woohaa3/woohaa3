import { expect, it, vi } from "vitest";
import type { AgentConnectionView, AgentCatalogResponse } from "@woohaa3/contracts";
import { AgentDirectoryStore } from "./directory.js";
import { generationIdentity, readRecentGeneration, recordAcceptedGeneration } from "./recent.js";
it("loads at most four catalogs at once, retains partial results and retries just the failed source", async () => {
 const connections = Array.from({length: 9}, (_, i) => ({ connectionId: `c${i}`,adapterId:`a${i}`, name:`连接${i}`, models:[] })) as unknown as AgentConnectionView[];
 let active=0, peak=0;
 const catalog=vi.fn(async(id?:string)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return id==='a1'?{ok:false as const,code:'offline',error:'offline'}:{ok:true as const,value:{models:[{id:`${id}/m`,label:'同名模型'}]} as AgentCatalogResponse};});
 const store=new AgentDirectoryStore({listConnections:async()=>({ok:true,value:connections}),catalog});await store.load();expect(peak).toBe(4);expect(store.getSnapshot().sourceStates.a1?.status).toBe('failed');expect(Object.keys(store.getSnapshot().catalogs)).toHaveLength(8);
 await store.load();expect(catalog).toHaveBeenCalledTimes(9);expect(store.getSnapshot().error).toContain('offline');
 catalog.mockResolvedValueOnce({ok:true,value:{models:[]} as unknown as AgentCatalogResponse});await store.retry('a1');expect(catalog).toHaveBeenCalledTimes(10);expect(store.getSnapshot().sourceStates.a1?.status).toBe('ready');expect(store.getSnapshot().error).toBe('');
});
it("invalidation rejects a late directory response", async()=>{
 let done!:(v:{ok:true;value:AgentConnectionView[]})=>void;
 const store=new AgentDirectoryStore({listConnections:()=>new Promise(resolve=>{done=resolve;}),catalog:vi.fn()});
 const pending=store.load();await Promise.resolve();store.invalidate();done({ok:true,value:[]});await pending;expect(store.getSnapshot().ready).toBe(false);
});
it("shares the four-read limit with local retries while initial catalogs are pending", async () => {
 const connections = Array.from({ length: 8 }, (_, i) => ({ connectionId: `c${i}`, adapterId: `a${i}`, name: `来源${i}`, models: [] })) as unknown as AgentConnectionView[];
 let active = 0, peak = 0;
 const catalog = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return { ok: true as const, value: { models: [] } as unknown as AgentCatalogResponse }; });
 const store = new AgentDirectoryStore({ listConnections: async () => ({ ok: true, value: connections }), catalog });
 const initial = store.load();
 await vi.waitFor(() => expect(catalog.mock.calls.length).toBeGreaterThanOrEqual(4), { interval: 1 });
 await Promise.all([initial, ...["a4", "a5", "a6", "a7"].map(id => store.retry(id))]);
 expect(peak).toBe(4); expect(catalog).toHaveBeenCalledTimes(12);
});
it("recent acceptance is public, deduplicated, and isolated by data space and purpose even without storage",()=>{
 const id=generationIdentity('connection','model');expect(readRecentGeneration('recent-one','text')).toEqual([]);
 recordAcceptedGeneration('recent-one','text',id);recordAcceptedGeneration('recent-one','text',id);
 expect(readRecentGeneration('recent-one','text')).toEqual([id]);expect(readRecentGeneration('recent-two','text')).toEqual([]);expect(readRecentGeneration('recent-one','world')).toEqual([]);
});

it("recent usage records frozen authoritative acceptance in its original namespace, including query recovery", async()=>{
 const {assistantConversationPort}=await import('./conversation-port.js');
 let space='port-original';let resolve!:(value:unknown)=>void;
 const service={getDataScopeId:()=>space,submitTurn:vi.fn(()=>new Promise(done=>{resolve=done;})),queryTurn:vi.fn(async()=>({ok:true,value:{conversation:{conversationId:'conversation'},turn:{target:{canvasId:'canvas',nodeId:'node'}}}}))} as unknown as import('../../contract/agent-conversation.js').AgentConversationService;
 const input={canvasId:'canvas',connectionId:'frozen-source',entry:{action:'generate',canvasId:'canvas',nodeId:'node',mode:'text',model:'frozen-model',prompt:'A'}} as import('../../contract/agent-conversation.js').AgentConversationSubmitInput;
 const port=assistantConversationPort(service);const pending=port.submit(input,'request');expect(readRecentGeneration('port-original','text')).toEqual([]);
 space='port-other';resolve({ok:true,value:{conversationId:'conversation',requestId:'request'}});await pending;
 expect(readRecentGeneration('port-original','text')).toEqual([generationIdentity('frozen-source','frozen-model')]);expect(readRecentGeneration('port-other','text')).toEqual([]);
 space='port-query';await port.query(input,'request');expect(readRecentGeneration('port-query','text')).toEqual([generationIdentity('frozen-source','frozen-model')]);expect(service.submitTurn).toHaveBeenCalledTimes(1);
});
