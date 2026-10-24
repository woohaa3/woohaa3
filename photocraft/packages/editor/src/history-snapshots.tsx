import {useEffect,useId,useRef,useState} from "react";
import type {PhotocraftCommand} from "@woohaa3/photocraft-protocol";
import {Button,IconButton} from "./ui/Button.js";
import {CursorMenu,DropdownMenu} from "./ui/Menu.js";
import {PencilIcon,TrashIcon,PlusIcon} from "./ui/icons.js";
const SNAPSHOT_DRAG_TYPE="application/x-photocraft-history-snapshot";
export function HistorySnapshots({snapshots,commands,disabled,onCommand}:{snapshots:readonly {id:number;name:string}[];commands:ReadonlyMap<string,PhotocraftCommand>;disabled:boolean;onCommand:(id:string,params:unknown)=>boolean}) {
 const [rename,setRename]=useState<{id:number;name:string;error:boolean}|null>(null);
 const [context,setContext]=useState<{id:number;x:number;y:number}|null>(null);
 const [dragging,setDragging]=useState(false),[overTrash,setOverTrash]=useState(false);
 const token=useId(),drag=useRef<number|null>(null);
 const enabled=(id:string)=>!disabled && !!commands.get(id)?.allowed && !!commands.get(id)?.enabled;
 const exists=(id:number)=>snapshots.some(snapshot=>snapshot.id===id);
 const beginRename=(id:number)=>{const snapshot=snapshots.find(snapshot=>snapshot.id===id);if(snapshot && enabled("history.renameSnapshot")){setContext(null);setRename({id,name:snapshot.name,error:false});}};
 const remove=(id:number)=>{if(exists(id) && enabled("history.deleteSnapshot"))onCommand("history.deleteSnapshot",{snapshot:id});};
 const commit=()=>{if(!rename || !exists(rename.id) || !enabled("history.renameSnapshot"))return;const name=rename.name.trim();if(!name || name.length>1024 || /[\u0000-\u001f\u007f]/.test(name)){setRename({...rename,error:true});return;}if(onCommand("history.renameSnapshot",{snapshot:rename.id,name}))setRename(null);};
 const clearDrag=()=>{drag.current=null;setDragging(false);setOverTrash(false);};
 useEffect(()=>{if(disabled){setContext(null);clearDrag();}},[disabled]);
 const canDrop=()=>drag.current!==null && exists(drag.current) && enabled("history.deleteSnapshot");
 return <div className="photo-editor__snapshots">
  <DropdownMenu label="创建历史快照" trigger={<Button size="sm" disabled={!enabled("history.newSnapshot")}><PlusIcon size={13}/>新建快照</Button>} items={([['fullDocument','完整文档'],['mergedLayers','合并图层'],['currentLayer','当前图层']] as const).map(([from,label])=>({id:from,label,disabled:!enabled("history.newSnapshot"),onSelect:()=>{if(enabled("history.newSnapshot"))onCommand("history.newSnapshot",{from});}}))}/>
  {snapshots.map(snapshot=><div className="photo-editor__snapshot" data-history-snapshot={snapshot.id} key={snapshot.id}
    onContextMenu={event=>{event.stopPropagation();if((event.target as Element).closest("input"))return;event.preventDefault();if(!disabled && (enabled("history.renameSnapshot") || enabled("history.deleteSnapshot")))setContext({id:snapshot.id,x:event.clientX,y:event.clientY});}}>
    {rename?.id===snapshot.id?<><input type="text" autoFocus maxLength={1024} title={rename.error?"请输入有效的快照名称":"快照名称"} value={rename.name} disabled={!enabled("history.renameSnapshot")} onChange={event=>setRename({...rename,name:event.currentTarget.value,error:false})} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==="Enter"){event.preventDefault();event.stopPropagation();commit();}else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setRename(null);}}}/><Button size="sm" disabled={!enabled("history.renameSnapshot")} onClick={commit}>确认</Button><Button size="sm" onClick={()=>setRename(null)}>取消</Button></>:<>
      <Button size="sm" tone="ghost" className="photo-editor__snapshot-name" disabled={!enabled("history.selectSnapshot")} onClick={()=>{if(enabled("history.selectSnapshot"))onCommand("history.selectSnapshot",{snapshot:snapshot.id});}}
        onDoubleClick={()=>beginRename(snapshot.id)} draggable={enabled("history.deleteSnapshot")}
        onDragStart={event=>{if(!enabled("history.deleteSnapshot") || !exists(snapshot.id)){event.preventDefault();return;}setContext(null);drag.current=snapshot.id;setDragging(true);event.dataTransfer.effectAllowed="move";event.dataTransfer.setData(SNAPSHOT_DRAG_TYPE,`${token}:${snapshot.id}`);}}
        onDragEnd={clearDrag}>{snapshot.name}</Button>
      <IconButton size="sm" label={`重命名快照 ${snapshot.name}`} disabled={!enabled("history.renameSnapshot")} onClick={()=>beginRename(snapshot.id)}><PencilIcon size={13}/></IconButton>
      <IconButton size="sm" label={`删除快照 ${snapshot.name}`} disabled={!enabled("history.deleteSnapshot")} onClick={()=>remove(snapshot.id)}><TrashIcon size={13}/></IconButton>
    </>}
  </div>)}
  <div className="photo-editor__snapshot-trash" data-snapshot-trash="" data-dragging={dragging && !disabled || undefined} data-over={overTrash || undefined}
    onDragOver={event=>{if(canDrop()){event.preventDefault();event.dataTransfer.dropEffect="move";setOverTrash(true);}}}
    onDragLeave={()=>setOverTrash(false)} onDrop={event=>{event.preventDefault();event.stopPropagation();const id=drag.current;if(canDrop() && id!==null && event.dataTransfer.getData(SNAPSHOT_DRAG_TYPE)===`${token}:${id}`)remove(id);clearDrag();}}><TrashIcon size={13}/>拖动快照到此处删除</div>
  {context && exists(context.id) && !disabled?<CursorMenu open onOpenChange={open=>{if(!open)setContext(null);}} x={context.x} y={context.y} label="历史快照" items={[
    {id:"rename",label:"重命名快照…",disabled:!enabled("history.renameSnapshot"),onSelect:()=>beginRename(context.id)},
    {id:"delete",label:"删除快照",danger:true,disabled:!enabled("history.deleteSnapshot"),onSelect:()=>{setContext(null);remove(context.id);}}
  ]}/>:null}
 </div>;
}
