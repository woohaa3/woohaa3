import {expect,it,vi} from "vitest";import {documentCloseTargets,closeDocumentBatch} from "../src/close-document-batch.js";
it("关闭其他保留调用时活动项，关闭全部最后结算活动项且不收录后来打开项",()=>{
 const entries=[{id:"a"},{id:"b"},{id:"c"}];expect(documentCloseTargets(entries,"b","others")).toEqual(["a","c"]);const ids=documentCloseTargets(entries,"b","all");entries.push({id:"d"});expect(ids).toEqual(["a","c","b"]);
});
it("每份等待保存完成，取消或失败立即停止后续文档",async()=>{
 let resolve!: (ok:boolean)=>void;const close=vi.fn((id:string)=>id==="a"?new Promise<boolean>(done=>{resolve=done;}):Promise.resolve(false));
 const result=closeDocumentBatch(["a","b","c"],close);expect(close.mock.calls).toEqual([["a"]]);resolve(true);expect(await result).toBe(false);expect(close.mock.calls).toEqual([["a"],["b"]]);
});
it("dispose停止后续关闭，抛出保存错误不继续关闭",async()=>{
 let active=true;const close=vi.fn(async()=>{active=false;return true;});expect(await closeDocumentBatch(["a","b"],close,()=>active)).toBe(false);expect(close).toHaveBeenCalledTimes(1);
 const fail=vi.fn(async()=>{throw new Error("保存失败");});await expect(closeDocumentBatch(["a","b"],fail)).rejects.toThrow("保存失败");expect(fail).toHaveBeenCalledTimes(1);
});

it("真实结算器逐份询问并保存，下载确认取消时保留该份和后续项",async()=>{
 const {settleDocument}=await import("../src/document-settlement.js");const open=new Set(["a","b","c"]),saved:string[]=[],asked:string[]=[];
 const result=await closeDocumentBatch(["a","b","c"],async id=>{
  const outcome=await settleDocument({documentId:id,name:id,dirty:true,pendingDraft:null,phase:"editing",message:null,nodeDocument:false,receiptUnknown:false,ui:{confirm:async()=>{asked.push(id);return true;},abandon:async()=>id!=="b"},save:async()=>{saved.push(id);return {ok:true,downloadOnly:true};},scope:"close"});
  if(outcome.ok)open.delete(id);return outcome.ok;
 });
 expect(result).toBe(false);expect(saved).toEqual(["a","b"]);expect(asked).toEqual(["a","b"]);expect([...open]).toEqual(["b","c"]);
});
