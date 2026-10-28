import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '../../../shared/ui/Button.js';
import { useService } from '../../react.js';
import { appBuildVersion } from '../../services/build-info.js';
import { sceneDiagnosticsSnapshot } from '../canvas-runtime/scene-diagnostics.js';
import { consumeSceneEntry, markSceneEntry, type SceneEntryOrigin, createScenePackageClient, numericTree, SceneFrameWindow, type SceneReceipt } from './scene-experience.js';
import { makeExperienceReport, type ExperienceFeedback, type ExperienceSample } from './report.js';
import { phaseLabels } from './import-controls.js';
import { SceneNavigationIntent } from './navigation-intent.js';
import './scene-experience.css';
const client=createScenePackageClient();
type View = keyof SceneReceipt['manifest']['views'];

/** This owner is mounted for one canvas. Normal canvases retain no collector or toolbar. */
export function SceneExperienceBar({canvasId,surfaceRef,ready,hidden=false}:{canvasId:string;surfaceRef:RefObject<HTMLElement>;ready:boolean;hidden?:boolean}) {
  const runtime=useService('canvasRuntime');
  const locate=useService('canvasLocate');
  const router=useService('appRouter');
  const catalog=useService('canvasCatalog');
  const selection=useService('canvasSelection');
  const [receipt,setReceipt]=useState<SceneReceipt|null>(null);
  const entryOrigin=useRef<SceneEntryOrigin>('reopen');
  const viewRef=useRef<View>('overview200');
  const [view,setView]=useState<View>('overview200');
  const [message,setMessage]=useState('');
  const [confirmRestore,setConfirmRestore]=useState(false);
  const [restoring,setRestoring]=useState(false);
  const [feedback,setFeedback]=useState<ExperienceFeedback>('');
  const barRef=useRef<HTMLElement>(null);
  const intent=useRef(new SceneNavigationIntent());
  const startupDone=useRef(false);
  const interacted=useRef(false);
  const frames=useRef(new SceneFrameWindow());
  const samples=useRef<ExperienceSample[]>([]);
  const operation=useRef<AbortController|null>(null);
  const resetId=useRef<string|null>(null);
  useEffect(()=>{
    const abort=new AbortController();setReceipt(null);startupDone.current=false;interacted.current=false;
    void client.receipt(canvasId,abort.signal).then(value=>{if(!abort.signal.aborted){if(value)entryOrigin.current=consumeSceneEntry(canvasId);setReceipt(value);}}).catch(()=>{});
    return ()=>{abort.abort();operation.current?.abort();intent.current.cancel();};
  },[canvasId]);

  useEffect(()=>{
    const surface=surfaceRef.current;if(!surface)return;
    const cancel=()=>{interacted.current=true;intent.current.cancel();};
    document.addEventListener('keydown',cancel,true);
    surface.addEventListener('pointerdown',cancel,true);surface.addEventListener('wheel',cancel,true);
    return ()=>{document.removeEventListener('keydown',cancel,true);surface.removeEventListener('pointerdown',cancel,true);surface.removeEventListener('wheel',cancel,true);};
  },[surfaceRef]);

  function safeArea() {
    const surface=surfaceRef.current?.getBoundingClientRect();const bar=barRef.current?.getBoundingClientRect();
    return {left:32,right:120,top:surface&&bar?Math.max(32,bar.bottom-surface.top+24):120,bottom:100};
  }
  function requestView(target:View,initial=false) {
    if(!receipt)return;
    const ticket=intent.current.begin();const started=performance.now();
    const attempt=()=>{
      if(!intent.current.current(ticket)||initial&&interacted.current)return;
      const engine=runtime.runtime();const scene=engine?.acceptedScene?.();
      const ids=receipt.manifest.views[target];
      // The accepted Render Scene owns effective model-card dimensions and resource remaps.
      // Do not use recipe coordinates or poll asynchronous picking for geometry.
      if(engine?.isReady() && scene && ids.every(id=>scene.nodes.some(node=>node.id===id))) {
        const result=locate.locateNodes(ids,{select:false,fit:true,safeArea:safeArea()});
        if(result.ok){viewRef.current=target;setView(target);setMessage('');return;}
        setMessage(result.reason);return;
      }
      if(performance.now()-started>=30000){setMessage('场景边界尚未就绪，请稍后重试取景。');return;}
      navigationTimer.current=window.setTimeout(attempt,100);
    };
    if(!initial)interacted.current=true;
    attempt();
  }
  const navigationTimer=useRef<number|undefined>();
  useEffect(()=>()=>{if(navigationTimer.current!==undefined)window.clearTimeout(navigationTimer.current);},[]);
  useEffect(()=>{
    if(receipt&&ready&&!startupDone.current){startupDone.current=true;requestView('overview200',true);}
  },[receipt,ready]);

  useEffect(()=>{
    if(!receipt)return;
    let disposed=false;let frame=0;let timer:ReturnType<typeof setTimeout>|undefined;
    frames.current.clear();samples.current=[];
    // rAF does only bounded numeric memory writes; no RPC, layout, disk or React updates.
    const tick=(at:number)=>{if(disposed)return;frames.current.push(at);frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
    const sample=async()=>{
      const engine=runtime.runtime();
      const work=await engine?.readSceneDiagnostics?.()??{value:null,reason:'unsupported'};
      if(disposed)return;
      const scene=engine?.acceptedScene?.();
      const at=performance.now();
      const health=engine?.runtimeHealthSnapshot?.()??null;
      const nodes=scene?.nodes.filter(node=>receipt.manifest.views[viewRef.current].includes(node.id))??[];
      const targetPresent=nodes.length===receipt.manifest.views[viewRef.current].length;
      const pending=nodes.some(node=>node.mediaLoading);
      const resourceReady=receipt.manifest.kind==='model3d'?null:targetPresent&&!pending&&nodes.every(node=>node.type!=='image'||node.texture);
      const readinessCriterion=receipt.manifest.kind==='model3d'?'model-resource-ready-unsupported':receipt.manifest.kind==='image'?'target-images-textured':'target-text-no-pending';
      samples.current.push({at,revision:scene?.revision??null,resourceReady,readinessCriterion,runtimePhase:typeof health?.phase==='string'?health.phase:null,work:work.value,reason:work.reason,frontend:numericTree(sceneDiagnosticsSnapshot()),
        health:health?numericTree(health):null,
        resources:runtime.resourceResidencyDiagnostics?.()?numericTree(runtime.resourceResidencyDiagnostics()):null,
        loading:scene?scene.nodes.filter(node=>node.mediaLoading).length:null,
        ready:scene?scene.nodes.filter(node=>node.texture).length:null});
      samples.current=samples.current.filter(entry=>entry.at>=at-30000).slice(-31);
      timer=setTimeout(()=>void sample(),1000);
    };
    void sample();
    return ()=>{disposed=true;cancelAnimationFrame(frame);if(timer)clearTimeout(timer);frames.current.clear();samples.current=[];};
  },[receipt,runtime]);

  async function restore() {
    if(!receipt)return;
    operation.current?.abort();const abort=new AbortController();operation.current=abort;
    setRestoring(true);setConfirmRestore(false);resetId.current??=crypto.randomUUID();
    try {
      let job=(await client.reset(canvasId,resetId.current,abort.signal)).job;
      while(!['ready','failed','cancelled'].includes(job.phase)) {
        if(abort.signal.aborted)return;
        setMessage(`${phaseLabels[job.phase]} · ${job.completedMedia} / ${job.totalMedia}`);
        await new Promise(resolve=>setTimeout(resolve,500));abort.signal.throwIfAborted();
        job=(await client.job(job.operationId,abort.signal)).job;
      }
      if(abort.signal.aborted)return;
      if(job.phase!=='ready') {setMessage(`${job.error?.code??job.phase}：${job.error?.message??'无法恢复，请检查本机保留的场景包。'}`);return;}
      markSceneEntry(job.canvasId,'reset');catalog.invalidate();selection.setRecentCanvasId(job.canvasId);router.navigate({page:'canvas',canvasId:job.canvasId});
    } catch(error){if(!abort.signal.aborted)setMessage(error instanceof Error?error.message:'恢复失败，请重试。');}
    finally{if(!abort.signal.aborted)setRestoring(false);}
  }
  function exportReport() {
    if(!receipt)return;
    const engine=runtime.runtime();
    const report=makeExperienceReport({receipt,entryOrigin:entryOrigin.current,safeArea:safeArea(),frames:frames.current,samples:samples.current,view,
      scene:engine?.acceptedScene?.()??null,surface:runtime.controller()?.surface()??null,
      backend:engine?.rendererBackend?.()??null,feedback,build:appBuildVersion()});
    // A user click is the sole export trigger. No background persistence or upload.
    const url=URL.createObjectURL(new Blob([JSON.stringify({...report,frontendCounters:numericTree(sceneDiagnosticsSnapshot())},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='woohaa-scene-report.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setMessage('报告已导出到本机。包含最近 30 秒计数；GPU 呈现指标未开放，报告记为未知。');
  }
  if(!receipt||hidden)return null;
  return <aside ref={barRef} className="scene-experience" data-testid="scene-experience-bar">
    <div className="scene-experience__summary"><strong>场景体验</strong><span>{receipt.manifest.kind} · {view==='overview300'?'300 节点':view==='overview200'?'200 节点':'远端区域'}</span></div>
    <div className="scene-experience__actions">
      <Button size="sm" disabled={!ready||restoring} onClick={()=>requestView('overview200')}>完整看 200 个</Button>
      <Button size="sm" disabled={!ready||restoring} onClick={()=>requestView('overview300')}>完整看 300 个</Button>
      <Button size="sm" disabled={!ready||restoring} onClick={()=>requestView('overview200')}>回到起点</Button>
      <Button size="sm" disabled={!ready||restoring} onClick={()=>requestView('distant')}>跳到远端</Button>
      <Button size="sm" disabled={restoring} onClick={()=>setConfirmRestore(true)}>恢复初始场景</Button>
      <Button size="sm" onClick={exportReport}>导出本机报告</Button>
      <select value={feedback} onChange={event=>setFeedback(event.target.value as ExperienceFeedback)}>
        <option value="">可选：本次体验反馈</option><option value="smooth">流畅</option><option value="stutter">有卡顿</option><option value="freeze">明显停顿</option><option value="missing-content">内容缺失</option>
      </select>
    </div>
    {confirmRestore?<div className="scene-experience__message">将从本机保留的场景包创建一张新的初始画布。当前画布和修改都会保留。
      <div className="scene-experience__actions"><Button size="sm" onClick={()=>void restore()}>创建初始场景副本</Button><Button size="sm" onClick={()=>setConfirmRestore(false)}>取消</Button></div>
    </div>:null}
    {message?<p className="scene-experience__message">{message}</p>:null}
  </aside>;
}
