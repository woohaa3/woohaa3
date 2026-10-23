import { useEffect, useRef, useState } from "react";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { PixelRect } from "../../photo-editor-tools.js";
import { CompositionOverlay } from "./overlays.js";
import { cropParams, isParamError } from "./workflows.js";

/** 裁剪工具与内核构图草稿共用生命周期；拖框、手柄、确认都走同一候选。 */
export function useCanvasCrop(controller: EditorWorkspaceController, width: number, height: number, changed: () => void, message: (value: string | null) => void) {
  const [frame,setFrame] = useState<PixelRect | null>(null);
  const [deletePixels,setDeletePixels] = useState(true);
  const active = useRef(false);
  const valid = useRef(false);
  const preview = (next: PixelRect) => {
    const params = cropParams({frame:next,angle:0,deleteCroppedPixels:deletePixels,contentAware:false,resample:"bicubic"});
    if (isParamError(params)) { valid.current=false;message(params.error);return; }
    const result = active.current ? controller.updateCompose(params) : controller.beginCompose("image.crop",params);
    if (!result.ok) { valid.current=false;message(result.message);return; }
    active.current=true;valid.current=true;setFrame(next);message(null);changed();
  };
  const cancel = () => { if(active.current)controller.cancelCompose();active.current=false;valid.current=false;setFrame(null);changed(); };
  useEffect(()=>()=>{if(active.current)controller.cancelCompose();},[controller]);
  return {active:active.current,frame,deletePixels,setDeletePixels,preview,cancel,
    confirm(){
      if(!active.current || !valid.current)return;
      const result=controller.commitCompose();
      if(!result.ok){active.current=false;valid.current=false;setFrame(null);message(result.message);changed();return;}
      active.current=false;valid.current=false;setFrame(null);changed();
    },
    overlay(origin:{x:number;y:number},zoom:number,readonly=false){
      return frame ? <CompositionOverlay state={{active:"crop",frame,document:{width,height},angle:0,grid:"thirds",allowOutside:false,onFrameChange:preview}} origin={origin} zoom={zoom} readonly={readonly}/> : null;
    }
  };
}
