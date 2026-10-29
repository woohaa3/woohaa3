#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {readSourceIdentity} from '../lib/source-identity.mjs';
import {generateScenePackage} from './scene-package.mjs';
import {encodeScenePackage,decodeScenePackage,encodeZipEntries} from '../../web/backend/src/scene-package/archive.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
const GUIDE=`Woohaa 海量画布体验（Windows x64）\r\n\r\n1. 运行安装包，启动 Woohaa。无需安装 Node、Rust 或开发服务。首次安装所需 WebView2 按安装器提示准备。\r\n2. 点击画布切换器中的“导入场景文件”，选择同目录 .woohaa-scene 文件，等待导入完成。三个文件独立导入。\r\n3. 每个场景有3000节点、12000连线；使用测试工具条切换200/300节点视图、定位远处、自由平移缩放和拖动。300节点视图中的图片/模型节点最多200个，其余是文本。\r\n4. 图片场景内含400张唯一512×512图片；模型场景内含400个自包含模型，当前产品最多16个模型预览获得槽位，不能将卡片数视为同时实时渲染的模型数。\r\n5. 分别体验首次加载期间和加载完成后的操作。首次进入、重开和恢复的缓存条件可能不同，勿直接比较。\r\n6. “恢复初始状态”经确认创建新初始画布；原先修改过的画布保留。\r\n7. 点击“导出体验报告”，选择主观反馈后把本地JSON文件发回。应用不会自动上传报告。\r\n8. 报告中的WebView刷新、Bevy调度完成和屏幕实际呈现是不同指标；缺失项标为不可用，不代表设备达到60FPS。\r\n\r\n安装与Windows原生渲染尚需真实设备验收；构建成功不是体验达标证明。安装包版本、commit及文件SHA-256见kit-manifest.json。\r\n`;
export async function buildExperienceKit({desktopManifest,clientRoot,output,revision,readIdentity=readSourceIdentity}){
 const assertClean=()=>{const identity=readIdentity(clientRoot);if(identity.dirty||identity.revision!==revision)throw Error('source revision mismatch or dirty source tree');};
 assertClean();
 if(!/^[a-f0-9]{40}$/.test(revision)||desktopManifest.sourceRevision!==revision||desktopManifest.sourceDirty!==false)throw Error('installer source revision mismatch or dirty build');
 if(desktopManifest.platform?.os!=='win32'||desktopManifest.platform?.arch!=='x64'||desktopManifest.hostPackage?.status!=='packaged'||desktopManifest.build?.debug)throw Error('requires standalone Windows x64 release installer');
 const version=desktopManifest.product?.version;if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))throw Error('invalid installer version');
 const artifacts=desktopManifest.artifacts?.filter(a=>a.kind==='nsis'&&a.name?.endsWith('.exe'));if(artifacts?.length!==1)throw Error('requires exactly one NSIS installer');
 const parts=version.split(/[.+-]/).slice(0,3).map(Number);if(parts[0]===0&&(parts[1]<1||(parts[1]===1&&parts[2]<6)))throw Error('installer version is not compatible with scene format');
 const artifact=artifacts[0];if(path.basename(artifact.name)!==artifact.name||/[<>:"/\\|?*\x00-\x1f]/.test(artifact.name))throw Error('invalid installer filename');
 const installerPath=path.isAbsolute(artifact.path)?artifact.path:path.resolve(clientRoot,artifact.path);const info=fs.statSync(installerPath);if(!info.isFile()||info.size>1024*1024*1024)throw Error('installer size unsupported');const installer=fs.readFileSync(installerPath);if(sha(installer)!==artifact.sha256||installer.length!==artifact.bytes)throw Error('installer hash mismatch');
 const input=new Map([[artifact.name,installer]]),scenes=[];
 for(const [kind,name] of [['text','3000-text.woohaa-scene'],['image','3000-images.woohaa-scene'],['model3d','3000-models.woohaa-scene']]){const p=generateScenePackage(kind),bytes=encodeScenePackage(p),verified=await decodeScenePackage(bytes);if(verified.canvas.document.nodes.length!==3000||verified.canvas.document.edges.length!==12000)throw Error('scene inventory mismatch');input.set(name,bytes);scenes.push({name,kind,datasetId:p.manifest.datasetId,contentHash:p.manifest.contentHash,recipeVersion:p.manifest.recipeVersion,formatVersion:p.manifest.version,nodes:3000,edges:12000,media:p.manifest.media.length});}
 input.set('体验说明.txt',Buffer.from(GUIDE,'utf8'));
 const manifest={schema:1,productVersion:version,sourceRevision:revision,platform:'windows-x64',verification:'pending-windows-device',scenes,files:[...input].map(([name,data])=>({name,bytes:data.byteLength,sha256:sha(data)}))};
 input.set('kit-manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 assertClean();
 const bytes=encodeZipEntries(input);fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});const temporary=`${output}.${randomUUID()}.tmp`;try{fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,output);}finally{fs.rmSync(temporary,{force:true});}
 const result={path:output,sha256:sha(bytes),bytes:bytes.byteLength,manifest};fs.writeFileSync(`${output}.sha256`,`${result.sha256}  ${path.basename(output)}\n`);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const manifestPath=process.argv[2];if(!manifestPath)throw Error('Usage: experience-kit.mjs <desktop-manifest.json> [output.zip]');const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();const result=await buildExperienceKit({desktopManifest:manifest,clientRoot:root,output:process.argv[3]??path.join(path.dirname(manifestPath),'woohaa-windows-x64-experience.zip'),revision});console.log(JSON.stringify({path:result.path,sha256:result.sha256,bytes:result.bytes}));}
