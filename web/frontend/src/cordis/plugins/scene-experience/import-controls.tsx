import { useEffect, useRef, useState } from 'react';
import { Button } from '@woohaa3/ui/primitives';
import { createScenePackageClient, markSceneEntry, type SceneJob } from './scene-experience.js';
import './scene-experience.css';
const defaultClient = createScenePackageClient();
export const phaseLabels:Record<SceneJob['phase'],string> = {
  uploaded:'已上传',validating:'正在校验场景包', 'staging-media':'正在准备本机媒体',committing:'正在创建画布',ready:'已就绪',failed:'导入失败',cancelled:'已取消',
};
export function ScenePackageImport({openCanvas,client=defaultClient}:{openCanvas:(id:string)=>void;client?:ReturnType<typeof createScenePackageClient>}) {
  const [available,setAvailable]=useState(false);
  const [message,setMessage]=useState('正在检查场景包支持…');
  const [job,setJob]=useState<SceneJob|null>(null);
  const [duplicate,setDuplicate]=useState(false);
  const [busy,setBusy]=useState(false);
  const upload=useRef<{file:File;id:string}|null>(null);
  const active=useRef<AbortController|null>(null);
  const opened=useRef(false);
  const fileInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void client.available(controller.signal).then(value=>{
      if(controller.signal.aborted) return;
      setAvailable(value.available);setMessage(value.available?'选择本地 .woohaa-scene 文件，导入后创建独立画布。':'当前宿主不支持场景包。');
    }).catch(error=>{if(!controller.signal.aborted)setMessage(error instanceof Error?error.message:'无法检查场景包支持');});
    return ()=>{controller.abort();active.current?.abort();};
  },[client]);
  async function run(copy=false) {
    if(!upload.current) return;
    active.current?.abort();const controller=new AbortController();active.current=controller;
    opened.current=false;setBusy(true);setMessage('正在上传并校验场景包…');setDuplicate(false);setJob(null);
    if(copy) upload.current.id=crypto.randomUUID();
    try {
      const response=await client.importFile(upload.current.file,upload.current.id,copy,controller.signal);
      if(controller.signal.aborted) return;
      setDuplicate(response.duplicate===true);setJob(response.job);
      let current=response.job;
      while(!['ready','failed','cancelled'].includes(current.phase)) {
        await new Promise(resolve=>setTimeout(resolve,500));
        controller.signal.throwIfAborted();
        current=(await client.job(current.operationId,controller.signal)).job;
        if(controller.signal.aborted) return;
        setJob(current);
      }
      if(current.phase==='ready' && !response.duplicate && !opened.current) {opened.current=true;markSceneEntry(current.canvasId,'first-import');openCanvas(current.canvasId);}
      setMessage(current.phase==='failed' ? `${current.error?.code ?? 'import-failed'}：${current.error?.message ?? '场景包导入失败，请重新选择文件。'}` : response.duplicate ? '这个场景包已有画布。打开已有画布，或导入一份副本。' : phaseLabels[current.phase]);
    } catch(error) {if(!controller.signal.aborted)setMessage(error instanceof Error?error.message:'导入失败，可重试本次上传。');}
    finally {if(!controller.signal.aborted)setBusy(false);}
  }
  return <section className="scene-package-import">
    <div className="scene-package-import__heading">本机场景体验</div>
    <p className="scene-package-import__hint">{message}</p>
    {job ? <p className="scene-package-import__hint">{phaseLabels[job.phase]} · {job.completedMedia} / {job.totalMedia} 个媒体</p> : null}
    <div className="scene-experience__actions">
      <input ref={fileInput} type="file" accept=".woohaa-scene" disabled={!available||busy} onChange={event=>{
        const file=event.currentTarget.files?.[0];if(!file)return;
        upload.current={file,id:crypto.randomUUID()};void run();event.currentTarget.value='';
      }} />
      {duplicate && job?.phase==='ready' ? <><Button size="sm" onClick={()=>openCanvas(job.canvasId)}>打开已有画布</Button><Button size="sm" onClick={()=>void run(true)}>导入副本</Button></> : null}
      {!busy && upload.current && !duplicate && job?.phase!=='ready' && job?.phase!=='cancelled' && job?.error?.retryable!==false ? <Button size="sm" onClick={()=>void run()}>重试本次导入</Button> : null}
      {busy && job ? <Button size="sm" onClick={()=>{
        const controller=active.current;
        void client.cancel(job.operationId,controller?.signal).then(({job:result})=>{
          if(controller!==active.current || controller?.signal.aborted)return;
          setJob(result);
          if(result.phase==='committing') {setMessage('画布正在提交，已无法取消；正在等待实际结果。');return;}
          if(!['ready','failed','cancelled'].includes(result.phase)) {setMessage(phaseLabels[result.phase]);return;}
          controller?.abort();setBusy(false);
          if(result.phase==='ready') {
            setMessage('画布已创建。');
            if(!opened.current){opened.current=true;markSceneEntry(result.canvasId,'first-import');openCanvas(result.canvasId);}
          } else if(result.phase==='cancelled') setMessage('已取消导入。');
          else setMessage(`${result.error?.code??'import-failed'}：${result.error?.message??'导入失败，请重试。'}`);
        }).catch(()=>{if(!controller?.signal.aborted)setMessage('取消失败，请重试。');});
      }}>取消导入</Button>:null}
    </div>
  </section>;
}
