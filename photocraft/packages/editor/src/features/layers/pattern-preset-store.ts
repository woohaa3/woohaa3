import {MAX_PATTERN_FILE_BYTES} from "../../editor-wasm.js";

export const PATTERN_LIBRARY_DATABASE="woohaa.image-editor.patterns.v1";
const STORE="library",KEY="current";
function open():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(PATTERN_LIBRARY_DATABASE,1);
    let blocked=false;
    request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
    request.onsuccess=()=>{if(blocked) request.result.close();else resolve(request.result);};
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>{blocked=true;reject(new Error("本机图案库正在被其他页面升级"));};
  });
}
function valid(bytes:unknown):bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.length>0 && bytes.length<=MAX_PATTERN_FILE_BYTES;
}
export async function readPatternLibrarySnapshot():Promise<Uint8Array|null> {
  if(typeof indexedDB==="undefined") return null;
  await pending.catch(()=>{});
  const database=await open();
  try {
    return await new Promise((resolve,reject)=>{
      const transaction=database.transaction(STORE,"readonly"),request=transaction.objectStore(STORE).get(KEY);
      transaction.oncomplete=()=>{
        if(request.result===undefined) resolve(null);
        else if(valid(request.result)) resolve(new Uint8Array(request.result));
        else reject(new Error("本机图案库快照格式无效或超限"));
      };
      transaction.onerror=()=>reject(transaction.error);
      transaction.onabort=()=>reject(transaction.error??new Error("读取本机图案库已中断"));
    });
  } finally {database.close();}
}
let pending:Promise<void>=Promise.resolve();
/** 按调用顺序提交完整快照；打开连接的先后顺序不会使旧版本覆盖新版本。 */
export function savePatternLibrarySnapshot(bytes:Uint8Array):Promise<void> {
  if(!valid(bytes)) return Promise.reject(new Error("本机图案库快照格式无效或超限"));
  const snapshot=new Uint8Array(bytes);
  const write=async()=>{
    const database=await open();
    try {
      await new Promise<void>((resolve,reject)=>{
        const transaction=database.transaction(STORE,"readwrite");
        transaction.objectStore(STORE).put(snapshot,KEY);
        transaction.oncomplete=()=>resolve();
        transaction.onerror=()=>reject(transaction.error);
        transaction.onabort=()=>reject(transaction.error??new Error("保存本机图案库已中断"));
      });
    } finally {database.close();}
  };
  const result=pending.catch(()=>{}).then(write);
  pending=result;return result;
}
