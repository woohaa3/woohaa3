import * as THREE from "three";
import JSZip from "jszip";
import { RelightPreviewMaterial, type RelightPreviewLayerBinding } from "./runtime/preview-material.js";
import { RELIGHT_LIGHTING_DEFAULTS, type RelightLightingSettings } from "./model/lighting.js";
import { RELIGHT_LAB_MATERIAL_DEFAULTS, type RelightRenderMode } from "./model/lab-settings.js";

type Page = Record<"body"|"surface"|"material"|"mask"|"shadow"|"baseColor",{png:string;ktx2:string;size:[number,number]}>;
type Stream = {key:string;directionId:string;actionId:string;connectorFor:string|null;pages:Page[];frames:{sourceFrame:number;page:number;rect:[number,number,number,number];size:[number,number]}[]};
type Manifest = {schema:string;streams:Stream[];initialStateId:string;actions:{stateId:string;phase:string;kind:string;clipSegments:{role:string;startFrame:number;endFrame:number}[]}[];transitions:{fromStateId:string;toStateId:string;authoredConnector:string;transitionId:string}[];directionPlan:{selectedDirections:string[];policy:Record<string,{kind:string;source?:string}>}};
const root=document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML='<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#252a30;color:#eee;font:14px system-ui}header{position:absolute;z-index:1;display:flex;align-items:center;gap:12px;padding:12px;background:#191d23dd;flex-wrap:wrap}select,button,input{font:inherit}canvas{display:block;width:100%;height:100%}p{position:absolute;bottom:0;left:16px;background:#191d23dd;padding:10px}input[type=file]{max-width:260px}</style><header><label>离线包 <input id="file" type="file" accept=".zip"></label><select id="action"></select><select id="direction"></select><select id="mode"><option value="original-unlit">Original</option><option value="inverse-relit">Relight</option><option value="normal">Surface / Normal</option><option value="roughness">Material / Roughness</option><option value="metallic">Material / Metallic</option><option value="depth">Shadow / Depth</option><option value="alpha">Mask / Alpha</option></select><label>灯光 <input id="light" type="range" min="-180" max="180" value="0"></label><button id="pause">暂停</button><button id="stop">Stop / Exit</button></header><p id="status">读取资产包…</p>';
const status=root.querySelector<HTMLParagraphElement>("#status")!,action=root.querySelector<HTMLSelectElement>("#action")!,direction=root.querySelector<HTMLSelectElement>("#direction")!,mode=root.querySelector<HTMLSelectElement>("#mode")!;
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;root.append(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.1,100);camera.position.z=5;
const material=new RelightPreviewMaterial(),geometry=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geometry,material);scene.add(mesh);
const lighting:RelightLightingSettings=structuredClone(RELIGHT_LIGHTING_DEFAULTS);lighting.directional.autoScan=false;
material.updateLabMaterial({...RELIGHT_LAB_MATERIAL_DEFAULTS,metallicUseMap:true,forceNonMetal:false});
material.updateMaterial({isGbufferEnabled:true,roughness:.7,metallic:0,specularIntensity:.4,normalStrength:1,deLightStrength:.6,albedoStrength:1,depthShadowStrength:.5});
let manifest:Manifest|null=null,paused=false,frame=0,lastTime=0,epoch=0,pending=false,release:(()=>void)|null=null,stopTarget:string|null=null;
let connectorFor:string|null=null,queuedTransition:Manifest["transitions"][number]|null=null;
let getFile=(name:string)=>new URL(name,location.href).href;
const cache=new Map<string,THREE.Texture>(),loader=new THREE.TextureLoader();
const texture=async(name:string,color:boolean)=>{const old=cache.get(name);if(old)return old;const next=await loader.loadAsync(getFile(name));next.flipY=false;next.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;next.minFilter=THREE.LinearFilter;next.magFilter=THREE.LinearFilter;cache.set(name,next);return next;};
const selectedStream=()=>{if(!manifest)return null;const policy=manifest.directionPlan.policy[direction.value],master=policy?.kind==="mirror"?policy.source:direction.value;return manifest.streams.find(s=>s.actionId===action.value&&s.directionId===master&&s.connectorFor===connectorFor)??null;};
async function drawFrame(stream:Stream,index:number,token:number){
  const f=stream.frames[index],page=stream.pages[f.page];if(!f||!page)return;
  pending=true;
  try{
    // Commit all six layers together. A failed page leaves the entire old frame visible.
    const names=Object.keys(page) as (keyof Page)[],textures=await Promise.all(names.map(n=>texture(page[n].png,n==="body"||n==="baseColor")));
    if(token!==epoch)return;
    const layer=(name:keyof Page):RelightPreviewLayerBinding=>({texture:textures[names.indexOf(name)],atlasRect:[f.rect[0]/page[name].size[0],f.rect[1]/page[name].size[1],f.rect[2]/page[name].size[0],f.rect[3]/page[name].size[1]],canvasRect:[0,0,1,1]});
    material.bind({body:layer("body"),surface:layer("surface"),material:layer("material"),mask:{...layer("mask"),channel:0},shadowDepth:layer("shadow"),baseColor:layer("baseColor"),mirrored:manifest!.directionPlan.policy[direction.value]?.kind==="mirror",normalDecode:{scale:[2,2,2],bias:[-1,-1,-1]},deLitRange:[-.7,.7],logicalAspect:f.size[0]/f.size[1],visibleBounds:[0,0,1,1],materialProfile:{roughnessScale:1,roughnessBias:0,roughnessMin:.05,roughnessMax:1,diffuseWrap:.1}});
    if(cache.size>36)for(const [key,value] of cache){if(cache.size<=36)break;if(!textures.includes(value)){value.dispose();cache.delete(key);}}
    mesh.scale.x=f.size[0]/f.size[1];status.textContent=`${stream.actionId} · ${direction.value} · 第 ${index+1} / ${stream.frames.length} 帧`;
  }catch{status.textContent="当前帧加载失败，保留上一个完整画面。";}finally{if(token===epoch)pending=false;}
}
async function load(value:Manifest){if(value.schema!=="creature-relight.v1"||!value.streams.length)throw new Error("资产包格式不正确");epoch++;pending=false;frame=0;stopTarget=null;connectorFor=null;queuedTransition=null;for(const t of cache.values())t.dispose();cache.clear();manifest=value;
  action.replaceChildren(...value.actions.map(a=>new Option(a.stateId,a.stateId)));action.value=value.initialStateId;direction.replaceChildren(...value.directionPlan.selectedDirections.map(d=>new Option(d.replace("_",":"),d)));const s=selectedStream();if(s)await drawFrame(s,0,epoch);
}
function switchStream(){epoch++;pending=false;frame=0;stopTarget=null;connectorFor=null;queuedTransition=null;const s=selectedStream();if(s)void drawFrame(s,0,epoch);}
action.onchange=switchStream;direction.onchange=switchStream;mode.onchange=()=>{lighting.view=mode.value as RelightRenderMode;};
root.querySelector<HTMLInputElement>("#light")!.oninput=e=>{lighting.directional.azimuth=Number((e.target as HTMLInputElement).value);};
root.querySelector<HTMLButtonElement>("#pause")!.onclick=e=>{paused=!paused;(e.target as HTMLButtonElement).textContent=paused?"播放":"暂停";};
root.querySelector<HTMLButtonElement>("#stop")!.onclick=()=>{if(!manifest)return;const state=manifest.actions.find(a=>a.stateId===action.value);const stop=state?.clipSegments.find(s=>s.role==="stop");if(stop){stopTarget=manifest.initialStateId;}else {queuedTransition=manifest.transitions.find(t=>t.fromStateId===action.value&&manifest!.actions.find(a=>a.stateId===t.toStateId)?.phase==="exit")??manifest.transitions.find(t=>t.fromStateId===action.value&&t.toStateId===manifest!.initialStateId)??null;if(!queuedTransition){action.value=manifest.initialStateId;switchStream();}}};
root.querySelector<HTMLInputElement>("#file")!.onchange=async e=>{const file=(e.target as HTMLInputElement).files?.[0];if(!file)return;try{const zip=await JSZip.loadAsync(file),urls=new Map<string,string>();let bytes=0;
  for(const entry of Object.values(zip.files)){if(entry.dir||!/^[-\w]+\.(?:png|ktx2|json)$/.test(entry.name))continue;const blob=await entry.async("blob");bytes+=blob.size;if(bytes>2*1024**3)throw new Error("资产包超限");urls.set(entry.name,URL.createObjectURL(blob));}
  release?.();release=()=>{for(const url of urls.values())URL.revokeObjectURL(url);};getFile=name=>{const url=urls.get(name);if(!url)throw new Error("资源缺失");return url;};await load(JSON.parse(await zip.file("manifest.json")!.async("string")));}catch{status.textContent="无法读取资产包，请检查完整性。";}};
const resize=()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();};addEventListener("resize",resize);resize();
renderer.setAnimationLoop(time=>{
  material.updateLighting(lighting,time,camera);material.syncObjectSpaceNormal(mesh,camera);renderer.render(scene,camera);
  if(paused||pending||!manifest||time-lastTime<1000/24)return;lastTime=time;const stream=selectedStream();if(!stream)return;
  const state=manifest.actions.find(a=>a.stateId===action.value);let next=frame+1;const loop=state?.clipSegments.find(s=>s.role==="loop");
  if(loop&&!stopTarget&&!queuedTransition&&!connectorFor&&next>loop.endFrame)next=loop.startFrame;
  else if(next>=stream.frames.length){
    if(queuedTransition){const transition=queuedTransition;action.value=transition.toStateId;epoch++;pending=false;frame=0;queuedTransition=null;connectorFor=transition.authoredConnector==="stop_or_exit_clip"?transition.transitionId:null;stopTarget=null;const s=selectedStream();if(s)void drawFrame(s,0,epoch);return;}
    if(connectorFor){connectorFor=null;frame=0;epoch++;pending=false;const s=selectedStream();if(s)void drawFrame(s,0,epoch);return;}
    if(stopTarget){action.value=stopTarget;switchStream();return;}
    if(state?.phase==="exit"){action.value=manifest.initialStateId;switchStream();return;}
    next=state?.kind==="loop"?0:stream.frames.length-1;
  }
  frame=next;void drawFrame(stream,frame,epoch);
});
addEventListener("pagehide",()=>{renderer.setAnimationLoop(null);for(const t of cache.values())t.dispose();cache.clear();release?.();material.dispose();geometry.dispose();renderer.dispose();});
void fetch(new URL("manifest.json",location.href)).then(r=>{if(!r.ok)throw Error();return r.json();}).then(load).catch(()=>{status.textContent="离线预览：选择解压前的生物资产 ZIP 包。";});
