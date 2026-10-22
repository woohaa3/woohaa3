import {IDBFactory} from "fake-indexeddb";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MAX_PATTERN_FILE_BYTES} from "./editor-wasm.js";
import {PATTERN_LIBRARY_DATABASE,readPatternLibrarySnapshot,savePatternLibrarySnapshot} from "./pattern-preset-store.js";
beforeEach(()=>vi.stubGlobal("indexedDB",new IDBFactory()));
afterEach(()=>vi.unstubAllGlobals());
it("本机快照按调用顺序落库，存储独立字节，读取等待已提交的管理动作",async()=>{
  expect(await readPatternLibrarySnapshot()).toBeNull();
  const first=new Uint8Array([1,2,3]),second=new Uint8Array([4,5]);
  const saveFirst=savePatternLibrarySnapshot(first),saveSecond=savePatternLibrarySnapshot(second);
  first[0]=9;second[0]=9;
  expect(await readPatternLibrarySnapshot()).toEqual(new Uint8Array([4,5]));
  await Promise.all([saveFirst,saveSecond]);
  const read=await readPatternLibrarySnapshot();read![0]=8;
  expect(await readPatternLibrarySnapshot()).toEqual(new Uint8Array([4,5]));
});
it("拒绝空快照和超限输入，失败保留已保存版本，存储故障后可重试",async()=>{
  await savePatternLibrarySnapshot(new Uint8Array([1]));
  await expect(savePatternLibrarySnapshot(new Uint8Array())).rejects.toThrow();
  await expect(savePatternLibrarySnapshot(new Uint8Array(MAX_PATTERN_FILE_BYTES+1))).rejects.toThrow();
  expect(await readPatternLibrarySnapshot()).toEqual(new Uint8Array([1]));
  const factory=indexedDB;
  vi.stubGlobal("indexedDB",{open:()=>{throw new Error("denied");}});
  await expect(savePatternLibrarySnapshot(new Uint8Array([2]))).rejects.toThrow("denied");
  vi.stubGlobal("indexedDB",factory);
  await savePatternLibrarySnapshot(new Uint8Array([3]));
  expect(await readPatternLibrarySnapshot()).toEqual(new Uint8Array([3]));
});
it("损坏的数据库值明确报错，缺少 IndexedDB 时仍可进入编辑器",async()=>{
  const database=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(PATTERN_LIBRARY_DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore("library");
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  await new Promise<void>((resolve,reject)=>{
    const transaction=database.transaction("library","readwrite");transaction.objectStore("library").put({bad:true},"current");
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);
  });database.close();
  await expect(readPatternLibrarySnapshot()).rejects.toThrow("格式无效");
  vi.stubGlobal("indexedDB",undefined);expect(await readPatternLibrarySnapshot()).toBeNull();
});
