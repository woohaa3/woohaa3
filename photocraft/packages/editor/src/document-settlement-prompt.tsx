import type {EditorDialogPort,EditorEditingOwner} from "./ports.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import {themedEditorDialogs} from "./editor-theme.js";
export type DocumentSettlementChoice="save"|"discard"|"cancel";
const ID="image-editor.document-settlement";
type Prompt={name:string;reason:string;acknowledge?:boolean;owner?:EditorEditingOwner|null};
/** Uses the host stack; no DOM modal or global browser confirmation is created. */
export function createDocumentSettlementPrompt(dialogs:EditorDialogPort,onError:(message:string)=>void) {
 const port=themedEditorDialogs(dialogs);
 let pending:{instanceId:string|null;finish:(choice:DocumentSettlementChoice)=>void}|null=null,disposed=false;
 function ask(input:Prompt):Promise<DocumentSettlementChoice> {
  if(disposed||pending||port.isModalActive())return Promise.resolve("cancel");
  return new Promise(resolve=>{
   let unregister:()=>void=()=>{},unsubscribe:()=>void=()=>{};
   const current={instanceId:null as string|null,finish:(choice:DocumentSettlementChoice)=>{
    if(pending!==current)return;
    pending=null;unsubscribe();if(current.instanceId)port.close(current.instanceId);unregister();resolve(choice);
   }};pending=current;
   const choose=(choice:DocumentSettlementChoice)=>{if(current.instanceId!==port.top()?.instanceId)return;current.finish(choice);};
   try {
    unregister=port.registerDialog(ID,{definition:{singleton:true,size:"sm",...(input.owner?{editingOwner:()=>input.owner!}:{}),validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的文档关闭请求"}},renderer:props=><DialogContent size="sm" ariaLabel={input.acknowledge?"确认文件已保存":"保存文档修改"} instanceId={props.instance.instanceId}>
      <DialogHeader onClose={()=>choose("cancel")}><DialogTitle>{input.acknowledge?"确认下载结果":"保存修改？"}</DialogTitle></DialogHeader>
      <DialogBody><p>{input.name}</p><p>{input.reason}</p>{!input.acknowledge?<p>不保存将丢弃此文档尚未保存的修改。</p>:null}</DialogBody>
      <DialogFooter><Button onClick={()=>choose("cancel")}>取消</Button>{!input.acknowledge?<Button tone="danger" onClick={()=>choose("discard")}>不保存</Button>:null}<Button tone="primary" data-dialog-initial-focus onClick={()=>choose("save")}>{input.acknowledge?"已保存并关闭":"保存"}</Button></DialogFooter>
     </DialogContent>});
    const result=port.open({dialogId:ID});if(!result.ok){onError(result.error);current.finish("cancel");return;}
    current.instanceId=result.instance.instanceId;
    unsubscribe=port.subscribe(()=>{if(port.top()?.instanceId!==current.instanceId)current.finish("cancel");});
    // A host participant may have synchronously closed the entry while publishing open.
    if(port.top()?.instanceId!==current.instanceId)current.finish("cancel");
   }catch(error){onError(error instanceof Error?error.message:"无法打开文档关闭确认");current.finish("cancel");}
  });
 }
 return {ask,dispose:()=>{disposed=true;pending?.finish("cancel");}};
}
