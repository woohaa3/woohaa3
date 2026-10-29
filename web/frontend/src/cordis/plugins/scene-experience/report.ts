import type { CanvasRenderScene } from '@woohaa3/contracts';
import { numericTree, SceneFrameWindow, type SceneReceipt } from './scene-experience.js';
export type ExperienceSample = {at:number;work:Record<string,unknown>|null;reason:string|null;health:Record<string,unknown>|null;resources:Record<string,unknown>|null;loading:number|null;ready:number|null;frontend?:Record<string,unknown>;revision?:number|null;resourceReady?:boolean|null;readinessCriterion?:string;runtimePhase?:string|null};
export type ExperienceFeedback = ''|'smooth'|'stutter'|'freeze'|'missing-content';
const safeId=(value:string) => /^[A-Za-z0-9_.-]{1,128}$/.test(value)?value:null;
function differences(first:unknown,last:unknown):Record<string,unknown> {
  const result:Record<string,unknown>={};
  if(!first||!last||typeof first!=='object'||typeof last!=='object') return result;
  for(const [key,value] of Object.entries(last)) {
    const before=(first as Record<string,unknown>)[key];
    if(typeof value==='number' && typeof before==='number') result[key]=value>=before?value-before:null;
    else if(value&&typeof value==='object') result[key]=differences(before,value);
  }
  return result;
}
export function makeExperienceReport(input:{receipt:SceneReceipt;frames:SceneFrameWindow;samples:ExperienceSample[];view:string;scene:CanvasRenderScene|null;surface:{width:number;height:number;pixelRatio:number}|null;safeArea?:{left:number;top:number;right:number;bottom:number};entryOrigin?:'first-import'|'reopen'|'reset';backend:'native'|'wasm'|null;feedback:ExperienceFeedback;build:string}) {
  const {receipt,scene,surface,samples}=input;
  const now=performance.now();
  const recent=samples.filter(sample=>sample.at>=now-30000).slice(-31);
  const first=recent[0],last=recent[recent.length-1];
  const viewport=scene?.viewport;
  const frameWindow=input.frames.snapshot(now);
  const runtimePhase=["running","recovering","degraded","disposed"].includes(String(last?.runtimePhase??last?.health?.phase))?String(last?.runtimePhase??last?.health?.phase):null;
  const previous=recent.length>1?recent[recent.length-2]:undefined;
  const revisionChanged=!!previous&&previous.revision!==last?.revision;
  const loading=(last?.loading??0)>0||last?.resourceReady===false||revisionChanged;
  const stable=!!last&&!!previous&&last.resourceReady===true&&previous.resourceReady===true&&last.revision===previous.revision&&last.at-previous.at>=1000;
  const collectionPhase=loading?"loading":stable?"stable":"unknown";
  const safe=input.safeArea??{left:0,top:0,right:0,bottom:0};
  const usable=surface?{left:safe.left,top:safe.top,right:surface.width-safe.right,bottom:surface.height-safe.bottom}:null;
  const fullyVisible=scene&&usable&&viewport ? scene.nodes.filter(n=>n.x*viewport.zoom+viewport.x >= usable.left && (n.x+n.width)*viewport.zoom+viewport.x <= usable.right && n.y*viewport.zoom+viewport.y >= usable.top && (n.y+n.height)*viewport.zoom+viewport.y<=usable.bottom).length : null;
  const intersecting=scene&&usable&&viewport ? scene.nodes.filter(n=>n.x*viewport.zoom+viewport.x < usable.right && (n.x+n.width)*viewport.zoom+viewport.x > usable.left && n.y*viewport.zoom+viewport.y < usable.bottom && (n.y+n.height)*viewport.zoom+viewport.y>usable.top).length : null;
  return {
    format:'woohaa-scene-report',version:1,app:'Woohaa3',build:input.build||null,
    platform:typeof navigator==='undefined'?null:/Windows/i.test(navigator.userAgent)?'windows':/Mac/i.test(navigator.userAgent)?'macos':/Linux/i.test(navigator.userAgent)?'linux':'other',
    rendererBackend:input.backend,
    entryOrigin:input.entryOrigin??'reopen',cacheState:{value:null,reason:'host-cache-state-not-observed'},
    collectionPhase:{value:collectionPhase,criterion:'stable requires observed target resources ready, no pending loads and unchanged revision across samples at least 1000 ms apart',readinessCriterion:last?.readinessCriterion??'unsupported',resourceReadyObserved:last?.resourceReady??null},
    runtimePhase,
    counterUnits:{frontendRaf:'milliseconds between frontend callbacks',health:'cumulative renderer event counts; deltas are counts',work:'suffix Ms denotes cumulative milliseconds, Bytes denotes bytes; other numeric counters retain renderer diagnostic units; unknown fields are not frame-rate measurements',timestamps:'frontend performance.now milliseconds; renderer clock never subtracted from frontend clock'},
    gpu:{adapter:null,api:null,reason:'adapter-metadata-not-exposed'},
    datasetId:safeId(receipt.manifest.datasetId),packageHash:safeId(receipt.packageHash),contentHash:safeId(receipt.manifest.contentHash),recipeVersion:receipt.manifest.recipeVersion,kind:receipt.manifest.kind,
    view:['overview200','overview300','distant'].includes(input.view)?input.view:null,nodeCount:scene?.nodes.length??null,edgeCount:scene?.edges.length??null,visibleCount:fullyVisible,intersectingCount:intersecting,partiallyVisibleCount:intersecting!==null&&fullyVisible!==null?intersecting-fullyVisible:null,usableContentRect:usable,
    viewport:viewport?{x:viewport.x,y:viewport.y,zoom:viewport.zoom}:null,surface,
    frontendRaf:{...frameWindow,meaning:'Frontend callback intervals, not Bevy renders or GPU presentation',clock:'frontend-performance-now',hidden:typeof document==='undefined'?null:document.visibilityState!=='visible'},
    bevyPostCleanup:{value:last?.health?.health??null,clock:'renderer-cumulative-counters',meaning:'RenderSystems PostCleanup completion, not GPU presentation'},
    gpuPresent:{value:null,reason:'unsupported'},
    counterDifference:first&&last?{work:differences(first.work,last.work),health:differences(first.health,last.health),frontend:differences(first.frontend,last.frontend)}:null,
    resourceReadiness:{textureReadyCount:last?.ready??null,loadingNodeCount:last?.loading??null,modelReadyCount:null,reason:'model-readiness-not-exposed'},
    qualityDropped:{frontendRafCapacity:frameWindow.capacityDropped,rollingExpiration:'normal-retention',renderer:{value:null,reason:'unsupported'}},samples:recent.map(sample=>({...sample,runtimePhase:['running','recovering','degraded','disposed'].includes(String(sample.runtimePhase))?sample.runtimePhase:null,readinessCriterion:['target-text-no-pending','target-images-textured','model-resource-ready-unsupported'].includes(sample.readinessCriterion??'')?sample.readinessCriterion:null,work:sample.work?numericTree(sample.work):null,health:sample.health?numericTree(sample.health):null,resources:sample.resources?numericTree(sample.resources):null})),
    feedback:['smooth','stutter','freeze','missing-content'].includes(input.feedback)?input.feedback:null,
  };
}
