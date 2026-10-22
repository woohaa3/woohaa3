import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root=dirname(dirname(fileURLToPath(import.meta.url))),windows=process.platform==="win32";
const resolve=name=>{
  const candidates=name==="python"?[join(root,"tools/.venv",windows?"Scripts/python.exe":"bin/python")]:[join(root,"tools/.runtime/bin",name+(windows?".exe":"")),join(root,"tools/.runtime/ktx/bin",name+(windows?".exe":""))];
  return process.env[`WOOHAA_CREATURE_${name.toUpperCase()}`]??candidates.find(existsSync)??name;
};
const manifest=JSON.parse(readFileSync(join(root,"tools/manifest.json"),"utf8"));
let ok=Number(process.versions.node.split(".")[0])>=Number(manifest.node.minimum);const report={platform:`${process.platform}-${process.arch}`,node:process.version,tools:{},resources:{},gpuCredential:Boolean(process.env.WOOHAA_CREATURE_GPU_TOKEN)};
for(const name of ["ffmpeg","ffprobe","toktx","python"]){
  const file=resolve(name),args=name==="python"?["-c","import sys,PIL,numpy;print(sys.version.split()[0],PIL.__version__,numpy.__version__)"]:name==="toktx"?["--version"]:["-version"],result=spawnSync(file,args,{encoding:"utf8",windowsHide:true,timeout:20000});
  const version=(result.stdout||result.stderr||"").trim().split(/\r?\n/)[0];let compatible;
  if(name==="toktx")compatible=version===`toktx v${manifest.toktx.version}`;
  else if(name==="python"){const [python,pillow,numpy]=version.split(" "),[major,minor]=python.split(".").map(Number);compatible=(major>3||major===3&&minor>=11)&&pillow==="11.3.0"&&numpy==="2.2.6";}
  else compatible=Number(/version\s+(\d+)/.exec(version)?.[1])>=Number(manifest.ffmpeg.minimum);
  const ready=result.status===0&&compatible;report.tools[name]={ready,version};ok&&=ready;
}
for(const name of ["dist/creature-preview.js","dist/creature-media-worker.js","python/cook_creature_bundle.py","python/unpack_creature_frames.py"]){const ready=existsSync(join(root,name));report.resources[name]=ready;ok&&=ready;}
try{const manifest=JSON.parse(readFileSync(join(root,"migration-manifest.json"),"utf8"));report.sourceCommit=manifest.sourceCommit;}catch{ok=false;}
report.ok=ok;console.log(JSON.stringify(report,null,2));if(!ok)process.exitCode=1;
