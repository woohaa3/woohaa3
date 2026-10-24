import {useLayoutEffect,useRef,type RefObject} from "react";
type Position={top:number;extent:number};
/** 工作区偏好仅跟随公共控制器身份；WeakMap 不保留已关闭文档。 */
const positions=new WeakMap<object,Map<number|null,Position>>();
export function useLayerScrollPosition(viewport:RefObject<HTMLElement>,owner:object|undefined,index:number|null,rowCount:number,onRestore:()=>void) {
  const restoring=useRef(false),restore=useRef(onRestore);restore.current=onRestore;
  const key=useRef<{owner:object|undefined;index:number|null}>({owner:undefined,index:null});
  useLayoutEffect(()=>{
    const changed=key.current.owner!==owner || key.current.index!==index;key.current={owner,index};
    const element=viewport.current,position=owner?positions.get(owner)?.get(index):undefined;
    if(!element || !position) return;
    restoring.current=true;element.scrollTop=position.top;restoring.current=false;
    if(changed) restore.current();
  },[owner,index,rowCount,viewport]);
  return ()=>{
    const element=viewport.current;if(!owner || !element || restoring.current) return;
    const extent=Math.max(0,element.scrollHeight-element.clientHeight),top=element.scrollTop;
    let entries=positions.get(owner);if(!entries) {entries=new Map();positions.set(owner,entries);}
    const previous=entries.get(index);
    // 组折叠/窗口变高造成的自动钳制不抹掉长列表的位置；恢复高度后仍回到原处。
    if(previous && extent<previous.extent && top>=extent) return;
    if(extent>0) entries.set(index,{top,extent});
  };
}
