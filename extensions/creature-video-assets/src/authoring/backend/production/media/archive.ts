import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, lstat } from "node:fs/promises";
import { join, relative, dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { WorkflowError } from "../../../../state/shared/workflow.js";
import { extensionRoot } from "../tools.js";
import { runTool } from "./process.js";

/** Production archives stay on disk. Python's ZIP reader streams individual members. */
export async function unpackFile(file:string,directory:string,stopped:()=>boolean):Promise<void> {
  await runTool("python",[join(extensionRoot(),"python/unpack_creature_frames.py"),file,directory],stopped);
}

/** Only internally produced directories may be packed. Never follow symlinks. */
export async function pack(directory:string,output:string):Promise<void> {
  const zip = new JSZip(); let total=0,count=0;
  const visit = async (dir:string) => {for (const entry of await readdir(dir,{withFileTypes:true})) {
    const file=join(dir,entry.name), info=await lstat(file);
    if(info.isSymbolicLink())throw new WorkflowError("unsafe-archive","归档含符号链接。");
    if(entry.isDirectory())await visit(file);
    else { total+=info.size;count++;if(total>20*1024**3||count>20_000)throw new WorkflowError("archive-limit","归档超过处理上限。");zip.file(relative(directory,file).replaceAll("\\","/"),createReadStream(file)); }
  }};
  await visit(directory);await pipeline(zip.generateNodeStream({streamFiles:true,compression:"STORE"}),createWriteStream(output,{flags:"wx"}));
}
/** ZIP readers must validate paths and advertised sizes before inflating any member. */
export async function unpack(bytes:Uint8Array,directory:string):Promise<void> {
  if(bytes.length>512*1024**2)throw new WorkflowError("archive-limit","帧包超过读取上限。");
  const zip=await JSZip.loadAsync(bytes), entries=Object.values(zip.files);let total=0;
  if(entries.length>20_000)throw new WorkflowError("archive-limit","帧包条目过多。");
  for(const entry of entries){
    const original=(entry as unknown as {unsafeOriginalName?:string}).unsafeOriginalName??entry.name;
    const file=resolve(directory,entry.name),size=(entry as unknown as {_data?:{uncompressedSize:number}})._data?.uncompressedSize??0;
    total+=size;
    if(!file.startsWith(resolve(directory)+sep)||original.split(/[\\/]/).includes("..")||original.includes("\\")||/^[a-z]:/i.test(original)||(Number(entry.unixPermissions)&0o170000)===0o120000)throw new WorkflowError("unsafe-archive","帧包路径非法。");
    if(size>64*1024**2||total>20*1024**3)throw new WorkflowError("archive-limit","帧包解压尺寸超限。");
  }
  for(const entry of entries){if(entry.dir)continue;const file=resolve(directory,entry.name);await mkdir(dirname(file),{recursive:true});let received=0;
    const stream=entry.nodeStream() as import("node:stream").Readable;stream.on("data",(chunk:Buffer)=>{received+=chunk.length;if(received>64*1024**2)stream.destroy(new Error("解压超限"));});await pipeline(stream,createWriteStream(file,{flags:"wx"}));}
}
