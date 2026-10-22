import {useEffect,useRef,useState} from "react";
import {Button} from "./ui/Button.js";
import {MAX_PATTERN_FILE_BYTES} from "./editor-wasm.js";
import type {PatternLibraryActions} from "./use-layer-properties-editing.js";

/** 管理选择独立于效果的图案选择；管理动作不应用到图层。 */
export function LayerStylePatternLibrary({library,disabled,onPickerActive}:{library:PatternLibraryActions;disabled:boolean;onPickerActive?:(active:boolean)=>void}) {
  const [key,setKey]=useState(""),[name,setName]=useState(""),[reading,setReading]=useState(false),[message,setMessage]=useState<string|null>(null);
  const input=useRef<HTMLInputElement>(null),generation=useRef(0),latest=useRef({library,onPickerActive});
  latest.current={library,onPickerActive};
  const selected=library.presets.find(p=>p.key===key),blocked=disabled || !library.ready || reading;
  useEffect(()=>{
    const clear=()=>latest.current.onPickerActive?.(false),element=input.current;
    setReading(false);setKey("");setName("");setMessage(null);
    element?.addEventListener("cancel",clear);window.addEventListener("focus",clear);
    return ()=>{generation.current++;clear();element?.removeEventListener("cancel",clear);window.removeEventListener("focus",clear);};
  },[disabled,library.owner]);
  const save=(selectedOnly:boolean)=>{
    const bytes=library.export(selectedOnly?selected?.key:undefined);if(!bytes) return;
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"}));
    const link=document.createElement("a");link.href=url;
    link.download=((selectedOnly?selected?.name:"用户图案")??"图案").replace(/[\\/:*?"<>|]/g,"_").slice(0,80)+".pat";
    onPickerActive?.(true);link.click();const revoke=URL.revokeObjectURL.bind(URL);
    setTimeout(()=>{revoke(url);if(document.hasFocus()) latest.current.onPickerActive?.(false);},0);
  };
  return <details data-pattern-library><summary>管理本机图案</summary>
    {!library.ready?<p>正在读取本机图案库…</p>:null}
    <div className="photo-editor__style-actions">
      <Button size="sm" tone="ghost" disabled={blocked} onClick={()=>{setMessage(null);onPickerActive?.(true);input.current?.click();}}>载入图案…</Button>
      <Button size="sm" tone="ghost" disabled={blocked || !library.presets.length} onClick={()=>save(false)}>保存图案库…</Button>
    </div>
    <input ref={input} type="file" accept=".pat" hidden data-pattern-file onChange={async event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value="";onPickerActive?.(false);
      if(!file || blocked) return;
      if(file.size>MAX_PATTERN_FILE_BYTES) {setMessage("PAT 文件不能超过 32 MiB");return;}
      const token=++generation.current;setReading(true);setMessage(null);
      try {
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(token!==generation.current) return;
        if(latest.current.library.import(bytes)) setMessage("图案已载入，请从效果的图案列表选择应用。");
      } catch {if(token===generation.current) setMessage("无法读取 PAT 文件，请重新选择。");}
      finally {if(token===generation.current) setReading(false);}
    }}/>
    {reading?<p>正在载入图案…</p>:null}{message?<p className="photo-editor__option-hint">{message}</p>:null}
    {library.presets.length?<><label>用户图案<select value={selected?key:""} disabled={blocked} onChange={event=>{
      const next=library.presets.find(p=>p.key===event.currentTarget.value);setKey(next?.key??"");setName(next?.name??"");
    }}><option value="">选择要管理的图案</option>{library.presets.map(p=><option value={p.key} key={p.key}>{p.name}（{p.width} × {p.height}）</option>)}</select></label>
      <label>图案名称<input value={name} maxLength={200} disabled={blocked || !selected} onChange={event=>setName(event.currentTarget.value)}/></label>
      <div className="photo-editor__style-actions">
        <Button size="sm" disabled={blocked || !selected || !name.trim()} onClick={()=>{if(selected && library.rename(selected.key,name)) {setName(name.trim());setMessage(null);}}}>重命名图案</Button>
        <Button size="sm" tone="ghost" disabled={blocked || !selected} onClick={()=>{if(selected && library.remove(selected.key)) {setKey("");setName("");setMessage(null);}}}>删除图案</Button>
        <Button size="sm" tone="ghost" disabled={blocked || !selected} onClick={()=>save(true)}>保存所选图案…</Button>
      </div></>:<p>载入 PAT 文件后，可在这里管理用户图案。默认图案保留在效果的图案列表中。</p>}
  </details>;
}
