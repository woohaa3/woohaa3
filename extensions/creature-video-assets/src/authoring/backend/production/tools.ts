import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function extensionRoot():string {
  let dir=dirname(fileURLToPath(import.meta.url));
  for(let i=0;i<9;i++){if(existsSync(join(dir,"extension.json")))return dir;dir=dirname(dir);}
  throw new Error("生物扩展发行资源不完整");
}
export function bundledTool(name:"ffmpeg"|"ffprobe"|"toktx"|"python"|"node"):string {
  if(name==="node")return process.execPath;
  const configured=process.env[`WOOHAA_CREATURE_${name.toUpperCase()}`];if(configured)return configured;
  const root=extensionRoot(),windows=process.platform==="win32";
  const candidates=name==="python"?[join(root,"tools/.venv",windows?"Scripts/python.exe":"bin/python")]:[join(root,"tools/.runtime/bin",name+(windows?".exe":"")),join(root,"tools/.runtime/ktx/bin",name+(windows?".exe":""))];
  return candidates.find(existsSync)??name;
}
