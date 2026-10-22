/** 调整层参数按帧合并，操作结束仅提交一步。 */
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {FrameEditSession} from "./frame-edit-session.js";
export type AdjustmentPatch={brightness?:number;contrast?:number;hue?:number;saturation?:number;lightness?:number;points?:[number,number][]};
type AdjustmentPort=Pick<EditorWorkspaceController,"beginAdjustment"|"previewAdjustment"|"commitAdjustment"|"cancelAdjustment">;
export class AdjustmentSession extends FrameEditSession<AdjustmentPatch> {
  constructor(controller:AdjustmentPort,refresh:()=>void,error:(message:string)=>void,onInfo:(info:unknown)=>void) {
    super({begin:layer=>controller.beginAdjustment(layer),preview:params=>controller.previewAdjustment(params),
      commit:()=>controller.commitAdjustment(),cancel:()=>controller.cancelAdjustment()},refresh,error,onInfo,
      (previous,next)=>({...previous,...next,...(next.points?{points:next.points.map(([x,y])=>[x,y] as [number,number])}:{})}));
  }
}
