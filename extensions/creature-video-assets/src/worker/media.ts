import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { applySemanticEnvelope, composeRgba } from "../authoring/backend/production/media/compose.js";

type Request={root:string;width:number;height:number;rgb:string[];masks:string[];hints:string[];output:string;preview:string};
async function main(){
  const request=JSON.parse(await readFile(process.argv[2],"utf8")) as Request,root=await realpath(request.root);
  const inside=async(file:string)=>{const actual=await realpath(file);if(!actual.startsWith(root+sep))throw Error("工作目录外的路径");return actual;};
  if(request.rgb.length!==request.masks.length||request.rgb.length!==request.hints.length||request.rgb.length>2400||request.width*request.height>4096**2)throw Error("帧序列非法");
  for(const path of [request.output,request.preview]){const actual=await realpath(path);if(!actual.startsWith(root+sep))throw Error("输出目录非法");}
  for(let frame=0;frame<request.rgb.length;frame++){
    const rgb=await inside(request.rgb[frame]),sam=await inside(request.masks[frame]),hint=await inside(request.hints[frame]);
    const name=`${String(frame+1).padStart(6,"0")}.png`,clean=join(root,`clean-${frame}.png`),rgba=join(request.output,name);
    await applySemanticEnvelope({samMask:sam,alphaHint:hint,output:clean,envelopePx:12,alphaFloor:2});
    const stats=await sharp(clean).stats();if(stats.channels[0].max<2)throw Error(`第 ${frame} 帧 Alpha 为空`);
    await composeRgba({rgb,alpha:clean,output:rgba,alphaFloor:2});
    const width=request.width,height=request.height;
    const checker=Buffer.from(`<svg width="${width}" height="${height}"><defs><pattern id="c" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="32" height="32" fill="#ddd"/><path d="M0 0h16v16H0zM16 16h16v16H16z" fill="#999"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`);
    const backgrounds=[await sharp({create:{width,height,channels:3,background:"#101218"}}).png().toBuffer(),await sharp({create:{width,height,channels:3,background:"#f2f2f2"}}).png().toBuffer(),await sharp(checker).png().toBuffer()];
    const panels=await Promise.all(backgrounds.map(b=>sharp(b).composite([{input:rgba}]).png().toBuffer()));
    await sharp({create:{width:width*3,height,channels:3,background:"#111"}}).composite(panels.map((input,p)=>({input,left:p*width,top:0}))).png().toFile(join(request.preview,name));
  }
  process.stdout.write(JSON.stringify({ok:true,frames:request.rgb.length}));
}
if(!process.argv[2]||!resolve(process.argv[2]).endsWith(".json"))process.exitCode=1;
else void main().catch(error=>{process.stderr.write(error instanceof Error?error.message:"媒体处理失败");process.exitCode=1;});
