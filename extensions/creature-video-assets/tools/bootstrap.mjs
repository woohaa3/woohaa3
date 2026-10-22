import { spawn } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root=dirname(dirname(fileURLToPath(import.meta.url))),windows=process.platform==="win32",runtime=join(root,"tools/.runtime"),venv=join(root,"tools/.venv");
await mkdir(join(runtime,"bin"),{recursive:true});
const run=(file,args)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{shell:false,windowsHide:true,stdio:"inherit"});child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error(`工具安装失败：${file}`)));});
await run(process.env.WOOHAA_CREATURE_UV??"uv",["venv",venv,"--python","3.12"]);
await run(process.env.WOOHAA_CREATURE_UV??"uv",["pip","install","--python",join(venv,windows?"Scripts/python.exe":"bin/python"),"--requirement",join(root,"tools/requirements.txt")]);
// Supply a trusted, already-downloaded encoder installation; never silently install system-wide.
const ktxIndex=process.argv.indexOf("--ktx-root");
if(ktxIndex>=0){const source=resolve(process.argv[ktxIndex+1]);const {cp}=await import("node:fs/promises");await cp(source,join(runtime,"ktx"),{recursive:true,force:false,errorOnExist:true});}
for(const name of ["ffmpeg","ffprobe"]){const i=process.argv.indexOf(`--${name}`);if(i>=0)await copyFile(resolve(process.argv[i+1]),join(runtime,"bin",name+(windows?".exe":"")));}
const records={};for(const name of ["ffmpeg","ffprobe","toktx"]){const file=name==="toktx"?join(runtime,"ktx/bin",name+(windows?".exe":"")):join(runtime,"bin",name+(windows?".exe":""));if(existsSync(file)){const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);records[name]={sha256:hash.digest("hex"),license:name==="toktx"?"Apache-2.0":"See supplied FFmpeg distribution license"};}}
await writeFile(join(runtime,"installed.json"),JSON.stringify({platform:`${process.platform}-${process.arch}`,tools:records},null,2));
console.log("扩展 Python 环境已建立。运行 tools:doctor 检查工具；toktx 安装来源见 tools/manifest.json，可用 --ktx-root 导入独立工具目录。");
